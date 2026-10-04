// Package app 是编排层:把 telegram / task / store / drive / rclone
// 拼成一个能端到端处理任务的进程。
//
// 依赖方向是单向的,各层互不知道对方:
//
//	telegram  ──收到 update──▶  app  ──判断该不该处理──▶  task
//	                                                       │
//	                                          ┌────────────┼────────────┐
//	                                       store         drive       rclone
//
// 这样每一层都能单独测:app 的测试注入假执行器,task 的测试注入
// 内存仓储,drive 的测试只验证连接串 —— 没有任何一层需要起真 Telegram。
package app

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/dispatcher"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/instance"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	"github.com/youngsx/drive-collector/cmd/collector/internal/task"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
	"github.com/youngsx/drive-collector/cmd/collector/internal/tgsession"
)

// DefaultDownloadDir 是下载落盘的默认位置。
//
// 刻意与 Node 侧一致:挂载卷、目录权限、清理脚本都按这个路径写的。
// 换路径会让「上传失败回退本地暂存」这条链路静默失效。
const DefaultDownloadDir = "/tmp/downloads"

// Config 是编排层的配置。
type Config struct {
	APIID   int
	APIHash string
	// Session 是 Node 已登录的 gramjs session。
	Session *tgsession.Session

	// DownloadDir 是下载落盘目录。必须有空间 —— 上传失败回退到
	// 本地暂存时依赖它(见 config 的 DIRECT_TRANSFER_FALLBACK_TO_LOCAL)。
	DownloadDir string

	// RemoteBase 是网盘上的基础路径。
	RemoteBase string

	// Repo 是任务仓储。
	Repo *store.Repository
	Log  *slog.Logger

	// Drives 是网盘仓储 —— 凭据按用户存在 D1,不能从环境变量读。
	Drives *store.DriveRepository

	// Auth 做 RBAC 判定。为 nil 时不装配 Dispatcher,命令被静默忽略。
	Auth *auth.Guard

	// Redis 是媒体组缓冲的存储 —— 必须是 Redis 而不是内存:
	// flush 由分布式锁保护,多实例下各存各的会各刷一半。
	Redis *redis.Client

	// Coord 是实例协调器(注册 + telegram_client 锁)。
	//
	// 必填:它决定 LB 把 webhook 转发给谁。缺了它,Go 会在没有抢到锁的
	// 情况下连接 Telegram,和 Node 双实例并发处理同一批消息 ——
	// 表现为「同一个文件被传两次」。
	Coord *instance.Coordinator
}

// App 是编排后的应用。
type App struct {
	tg *tgclient.Client
	// downloader 默认可用 tg;测试注入假实现。
	// 单独一个字段是因为 download 要用假实现测,而 tg 是具体类型。
	downloader Downloader
	// mediaGroups 聚合用户连发的多条消息。为 nil 时媒体组会退化成
	// 逐条任务(用户发 10 张图变 10 个任务),所以 wiring 时必须给。
	mediaGroups *task.MediaGroupBuffer
	tasks       *task.Manager
	locks       *drive.SessionLock
	rclone      Rclone
	repo        TaskRepo
	drives      DriveRepo
	dispatcher  *dispatcher.Dispatcher
	cfg         Config
	log         *slog.Logger

	// pending 是「建完任务、等着被处理」的队列。
	//
	// 为什么需要它:worker 模式下 Node 侧那条「建任务 → 发 QStash →
	// webhook 回调」的链路【不存在】—— Go 没有 QStash 发布器。建完
	// 任务没人触发下载,任务就永远停在 queued。
	//
	// 生产实测:一条真实视频消息建出了任务,状态卡在 queued 不动,
	// 而日志里一切正常 —— 属于最难发现的一类故障。
	//
	// 单实例下用内存队列足够;多实例时它必须换成 Redis 队列(每个
	// 实例只能处理自己建的任务,否则会重复下载)。
	pending chan string
}

// New 构造 App。此时不连接 Telegram、不碰网盘。
func New(cfg Config) (*App, error) {
	if cfg.Repo == nil {
		return nil, fmt.Errorf("app: 需要任务仓储")
	}
	if cfg.Session == nil {
		return nil, fmt.Errorf("app: 需要已登录的 session")
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.DownloadDir == "" {
		// 与 Node 侧一致(Dockerfile 里 chown node:node /tmp/downloads,
		// docker-compose 挂 ./downloads:/tmp/downloads)。
		// 之前用 /tmp/drive-collector,既不匹配挂载点也没人给过写权限 ——
		// 容器里以非 root 运行时,下载会直接失败。
		cfg.DownloadDir = DefaultDownloadDir
	}

	a := &App{
		locks:   drive.NewSessionLock(),
		rclone:  rclone.NewRunner(),
		repo:    cfg.Repo,
		drives:  cfg.Drives,
		cfg:     cfg,
		log:     cfg.Log,
		pending: make(chan string, pendingQueueSize),
	}

	// task.Manager 只负责「该不该处理」和状态推进,具体怎么做由这里注入。
	manager := task.NewManager(cfg.Repo, cfg.Log)
	manager.Download = a.download
	manager.Upload = a.upload

	tg, err := tgclient.New(tgclient.Config{
		APIID:   cfg.APIID,
		APIHash: cfg.APIHash,
		Session: cfg.Session,
		Handler: a.onUpdate,
		Log:     cfg.Log,
	})
	if err != nil {
		return nil, err
	}

	a.tg = tg
	a.downloader = tg
	a.tasks = manager

	// 媒体组缓冲:用户连发多图时聚合成一批。
	if cfg.Redis != nil {
		a.mediaGroups = task.NewMediaGroupBuffer(cfg.Redis, task.BufferConfig{
			Log: cfg.Log,
		})
		// 刷出的组要真的建任务 —— 不接这个回调,组会被清掉但任务不建,
		// 用户的图片就凭空消失了。
		a.mediaGroups.FlushGroup = a.flushMediaGroup
	}

	// Dispatcher 在这里装配而不是在 main —— 它需要 tg / auth / tasks 三样
	// 依赖,而 tg 是本包内部创建的。放外面就得额外导出一个构造顺序约束。
	if cfg.Auth != nil {
		a.dispatcher = dispatcher.New(dispatcher.Deps{
			Telegram: tg,
			Auth:     cfg.Auth,
			Tasks:    a,
			Renders:  a,
			Log:      cfg.Log,
		})
	}
	return a, nil
}

// Run 启动并阻塞到 ctx 结束。
func (a *App) Run(ctx context.Context) error {
	// 清掉上次运行残留的下载文件。
	//
	// 上传失败的任务会把文件留在盘上(刻意留着,方便排查),而它们
	// 对应的任务会被 recoverOnStart 重新排队 —— 重跑时会重新下载。
	// 不清的话容器磁盘(1GB)会一天天涨到满,而盘满的表现是
	// 【所有】任务一起失败,不是单个任务。
	_ = os.RemoveAll(a.cfg.DownloadDir)
	if err := os.MkdirAll(a.cfg.DownloadDir, 0o755); err != nil {
		return fmt.Errorf("app: 创建下载目录失败: %w", err)
	}
	if a.cfg.Coord == nil {
		return fmt.Errorf("app: 缺少实例协调器 —— 没有锁就连接 Telegram 会与 Node 双实例并发")
	}
	if a.mediaGroups == nil {
		// 不是警告而是错误:媒体组缓冲缺失意味着用户发 10 张图会变
		// 10 个任务,而这【不报错】—— 用户只会看到结果不对。
		return fmt.Errorf("app: 缺少媒体组缓冲 —— 连发多图会退化成逐条任务")
	}

	// 先注册,再抢锁。顺序不能反:注册让 Node 知道本实例活着,
	// 抢锁才不会被 Node 判定为「残留锁可抢占」。
	if err := a.cfg.Coord.Register(ctx); err != nil {
		return fmt.Errorf("app: 实例注册失败: %w", err)
	}

	held, err := a.cfg.Coord.AcquireTelegramLock(ctx)
	if err != nil {
		return fmt.Errorf("app: 抢 telegram_client 锁失败: %w", err)
	}
	if !held {
		// 别人还持着锁。这不是错误 —— 是「现在不该我处理」。
		// 硬失败比安静等待好:调用方(容器编排)会看到明确的退出原因,
		// 而不是服务「活着但什么都不做」。
		return fmt.Errorf("app: telegram_client 锁被 %s 持有,本实例不接管",
			a.cfg.Coord.ID())
	}
	a.log.Info("已持有 telegram_client 锁,开始接管",
		"instance", a.cfg.Coord.ID(), "ttl", "90s")

	// 捞回上次运行遗留的组与僵尸任务。
	//
	// 必须在抢到锁【之后】做:那才是「这个实例负责处理」的信号。
	// 启动时进程会丢掉所有内存里的定时器,组就永远留在 Redis 里不刷,
	// 僵尸任务也永远停在 downloading —— 用户等的是「永远不出现」。
	//
	// 周期跑而不是只跑一次:内存队列里的任务在崩溃时会丢,而它们
	// 状态还是 queued —— 只靠启动时扫一遍的话,那些任务要等到【下次
	// 重启】才被捞回。周期扫描让它们最多等一个周期。
	go a.recoverLoop(ctx)

	// 任务消费循环:把新建的任务推到终态。
	//
	// 抢到锁【之后】才起:只有负责处理的实例才该动网盘。
	// 这也是 worker 模式与 edge 模式的分界线 —— edge 只转发 webhook,
	// 不开这个循环。
	go a.runTaskQueue(ctx)

	// 续租:失去锁必须立刻停手,否则会和新主人双实例并发。
	// 这是「切流量」的触发点 —— LB 下一个请求就打到新主人了。
	lockCtx, cancelLock := context.WithCancel(ctx)
	defer cancelLock()
	lockLost := make(chan error, 1)
	go func() { lockLost <- a.cfg.Coord.RunLockHeartbeat(lockCtx) }()

	tgCtx, cancelTG := context.WithCancel(ctx)
	defer cancelTG()
	go func() {
		select {
		case err := <-lockLost:
			if err != nil && tgCtx.Err() == nil {
				a.log.Error("失去锁,断开 Telegram 客户端", "err", err)
				cancelTG()
			}
		case <-tgCtx.Done():
		}
	}()

	return a.tg.Run(tgCtx)
}

// recoverLoop 周期性地捞回遗留物,直到 ctx 结束。
//
// 为什么不是只跑一次:内存队列在崩溃时会丢,而丢掉的任务状态还是
// queued —— 只扫一次的话它们要等到下次重启才被捞回。周期扫描把
// 最坏等待压到一个周期。
//
// 周期取 StalledThreshold 的一半:任务被判为「卡住」之后最多再等
// 这么久就会被重新排队。太短会频繁扫库(每次一条 D1 查询)。
func (a *App) recoverLoop(ctx context.Context) {
	a.recoverOnStart(ctx)

	ticker := time.NewTicker(StalledThreshold / 2)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.recoverOnStart(ctx)
		}
	}
}

// recoverOnStart 捞回上次运行的遗留物。
//
// 两个都是「重启后会静默消失」的东西:
//   - 媒体组:定时器全在内存里,进程一死组就卡在缓冲里不刷
//   - 僵尸任务:停在 downloading/uploading,用户永远等不到结果
func (a *App) recoverOnStart(ctx context.Context) {
	// 媒体组
	//
	// nil 守卫不是多余的:本函数跑在后台 goroutine 里,panic 会直接
	// 终止整个进程。Run 虽然已经检查过 mediaGroups,但那是另一条路径 ——
	// 这里自己守住,免得将来有人单独调用它。
	if a.mediaGroups != nil {
		if n, err := a.mediaGroups.Restore(ctx); err != nil {
			a.log.Warn("捞回遗留媒体组失败", "err", err)
		} else if n > 0 {
			a.log.Info("已捞回遗留媒体组", "组数", n)
		}
	}

	// 僵尸任务:重置为 queued 并重新排队。
	//
	// 注意 FindStalledTasks 会把 queued 也算进来(它只排除终态)。
	// 而 reset_stalled 的合法来源是 downloading/downloaded/uploading ——
	// 对 queued 调用会被状态机拒绝。所以这里必须按状态分流:
	//   - queued:状态本来就对,直接排队(它正是「建了没人处理」的那批)
	//   - 其余:先重置再排队
	stalled, err := a.repo.FindStalledTasks(ctx, StalledThreshold)
	if err != nil {
		a.log.Warn("查询僵尸任务失败", "err", err)
		return
	}
	if len(stalled) == 0 {
		return
	}

	reset, requeued := 0, 0
	for _, tsk := range stalled {
		if tsk.Status != contract.StatusQueued {
			if _, terr := a.repo.Transition(ctx, tsk.ID, contract.EventResetStalled, nil); terr != nil {
				a.log.Warn("重置僵尸任务失败", "taskId", tsk.ID, "status", tsk.Status, "err", terr)
				continue
			}
			reset++
		}
		// 重置完必须自己排队。这里原来只把状态改回 queued 就完事,
		// 注释写着「让随后的 webhook 重新处理」—— 而 worker 模式下
		// 那个 webhook 永远不会来,重置等于把任务再卡一次。
		a.enqueue(ctx, tsk.ID)
		requeued++
	}
	a.log.Info("已恢复僵尸任务", "重置", reset, "重新排队", requeued)
}

// StalledThreshold 是判定「任务卡住」的时间。
//
// 与 Node 侧一致(约 5 分钟):短了会把正在下载的大文件误判为僵尸,
// 长了用户要多等。
const StalledThreshold = 5 * time.Minute

// TG 暴露 Telegram 客户端,供发消息等场景使用。
func (a *App) TG() *tgclient.Client { return a.tg }

// Tasks 暴露任务管理器。
func (a *App) Tasks() *task.Manager { return a.tasks }

// HandleDownloadWebhook 处理下载 webhook —— 边缘节点收到时调用。
//
// 这是 Go 真正接管流量的入口:验签在 edge 层已经做完,
// 这里只负责业务。
func (a *App) HandleDownloadWebhook(ctx context.Context, taskID string) (task.Result, error) {
	return a.tasks.HandleDownload(ctx, taskID)
}

// HandleUploadWebhook 处理上传 webhook。
func (a *App) HandleUploadWebhook(ctx context.Context, taskID string) (task.Result, error) {
	return a.tasks.HandleUpload(ctx, taskID)
}

// onUpdate 是 Telegram update 的总入口。
//
// 分流顺序很关键:命令优先,媒体其次。
// 反过来的话,用户发「/status」会先被判成「无媒体的文本消息」而丢弃 ——
// 而带媒体的 /status 之类消息会被误建任务。
func (a *App) onUpdate(ctx context.Context, u tgclient.Update) error {
	switch u.Kind {
	case tgclient.KindCallbackQuery:
		return a.handleCallback(ctx, u)

	case tgclient.KindNewMessage, tgclient.KindMediaGroup:
		msg, ok := messageOf(u)
		if !ok {
			return nil
		}

		// 命令优先:带媒体的消息里也可能带 / 开头的内容,
		// 但命令是用户明确的意图,不能被当成文件投递。
		if strings.HasPrefix(strings.TrimSpace(msg.Text), "/") {
			return a.routeCommand(ctx, msg)
		}

		if !msg.HasMedia {
			return nil // 普通聊天内容,不做任何事
		}

		// 媒体组走缓冲:用户连发 10 张图,Telegram 推 10 条 update(同
		// 一个 grouped_id)。不聚合就是 10 个独立任务 —— 而且不报错,
		// 只是结果不对。
		if msg.GroupedID != 0 && a.mediaGroups != nil {
			return a.mediaGroups.Add(ctx, task.NormalizeGID(msg.GroupedID),
				msg.ChatID, msg.SenderID, int64(msg.ID))
		}
		return a.createTaskFrom(ctx, u)

	default:
		a.log.Debug("暂不处理的 update", "kind", u.Kind, "pts", u.Pts)
		return nil
	}
}

// routeCommand 把命令交给 Dispatcher。
func (a *App) routeCommand(ctx context.Context, msg messageInfo) error {
	if a.dispatcher == nil {
		a.log.Debug("命令被忽略:dispatcher 未装配", "text", msg.Text)
		return nil
	}
	_, err := a.dispatcher.HandleText(ctx, msg.ChatID, fmt.Sprintf("%d", msg.SenderID), msg.Text)
	if err != nil {
		// 命令处理失败不该让客户端重连 —— 否则一条坏命令会变成
		// 断线重连风暴。记日志就好。
		a.log.Error("命令处理失败", "text", msg.Text, "err", err)
	}
	return nil
}

// handleCallback 处理按钮点击。
//
// B 方案没实现需要按钮的命令,所以这里只回一个「暂不可用」——
// 静默不回会让 Telegram 客户端的转圈动画一直转(15 秒超时)。
func (a *App) handleCallback(ctx context.Context, u tgclient.Update) error {
	callbackID, data, ok := tgclient.CallbackData(u)
	if !ok {
		return nil
	}
	// 无论如何都要回应 —— 不回应客户端会一直转圈。
	if err := a.tg.AnswerCallback(ctx, callbackID, "该功能暂未迁移", false); err != nil {
		a.log.Warn("回应按钮失败", "err", err)
	}
	a.log.Debug("收到按钮点击", "data", data)
	return nil
}

func (a *App) createTaskFrom(ctx context.Context, u tgclient.Update) error {
	msg, ok := messageOf(u)
	if !ok {
		return nil
	}
	// 自己发出去的消息不能建任务(那是 bot 的回复)。
	if a.tg.SelfID() != 0 && msg.SenderID == a.tg.SelfID() {
		return nil
	}
	if !msg.HasMedia {
		// 纯文本消息不建任务 —— 这个 bot 收的是文件不是聊天。
		return nil
	}

	taskID := newTaskID()
	t := store.Task{
		ID:         taskID,
		UserID:     fmt.Sprintf("%d", msg.SenderID),
		SourceType: "telegram_media",
		FileName:   nullableString(msg.FileName),
		SourceRef:  nullableString(BuildSourceRef(msg.ChatID, int64(msg.ID))),
		// MsgID 是这条状态消息本身;SourceMsgID 是【被转存的那条消息】。
		// 两者都是单条消息 id —— Node 侧 addBatchTasks 写的也是 msg.id。
		// 曾经写成 grouped_id,会让「按源消息反查任务」全部失效,
		// 而且不报错(取消整批时只表现为"点了没反应")。
		MsgID:       nullableInt(int64(msg.ID)),
		SourceMsgID: nullableInt(msg.SourceMsgID),
	}

	if err := a.repo.Create(ctx, t); err != nil {
		a.log.Error("创建任务失败", "err", err)
		// 返回 nil:创建失败不该让客户端重连,否则一条坏消息
		// 会变成断线重连风暴。
		return nil
	}
	a.log.Info("任务已创建", "taskId", taskID, "file", msg.FileName)
	// 建完必须立刻排队处理。漏了这一步任务会永远停在 queued ——
	// worker 模式下没有 QStash 回调会来推它。
	a.enqueue(ctx, taskID)
	return nil
}

// download 把 Telegram 文件拉到本地。
func (a *App) download(ctx context.Context, t store.Task) error {
	if !t.SourceRef.Valid || t.SourceRef.String == "" {
		return fmt.Errorf("任务 %s 没有源引用", t.ID)
	}
	chatID, msgID, err := ParseSourceRef(t.SourceRef.String)
	if err != nil {
		return fmt.Errorf("任务 %s 的 sourceRef 无法解析: %w", t.ID, err)
	}

	dest := filepath.Join(a.cfg.DownloadDir, sanitize(t.FileName.String))
	if err := a.downloader.DownloadTo(ctx, chatID, msgID, dest, func(ratio float64) {
		a.log.Debug("下载中", "taskId", t.ID, "ratio", ratio)
	}); err != nil {
		return fmt.Errorf("下载失败: %w", err)
	}

	// 真实大小必须用文件系统的值 —— 记忆里 PR#458 的教训:
	// Telegram 给的只是估算值,拿它当 --size 判据会让 rclone
	// 报 "sizes differ",任务被误判为不可重试而直接判死。
	info, err := os.Stat(dest)
	if err != nil {
		return fmt.Errorf("下载后取文件信息失败: %w", err)
	}
	if err := a.repo.UpdateFileMetadata(ctx, t.ID, filepath.Base(dest), info.Size()); err != nil {
		return err
	}
	return nil
}

// upload 把本地文件推到网盘。
func (a *App) upload(ctx context.Context, t store.Task) error {
	if !t.FileName.Valid {
		return fmt.Errorf("任务 %s 没有文件名", t.ID)
	}
	local := filepath.Join(a.cfg.DownloadDir, sanitize(t.FileName.String))

	// 凭据从 D1 按用户取 —— 每个用户的网盘凭据不同,存在
	// drives.config_data 里(明文 JSON,不是加密的)。
	// 不能从环境变量读:生产没有 DRIVE_USER/DRIVE_PASS 这类变量。
	d, err := a.drives.DefaultDrive(ctx, t.UserID)
	if err != nil {
		return fmt.Errorf("查询用户 %s 的网盘失败: %w", t.UserID, err)
	}
	if d == nil {
		return fmt.Errorf("用户 %s 没有绑定网盘", t.UserID)
	}

	// 用户在 UI 里设的目录优先,退回全局默认。
	//
	// 传的是【不含连接串】的路径 —— 拼接由 rclone 层做(见 Config.target),
	// 在调用方拼的话每个调用点都要记得拼一次,漏一个就会把网盘路径
	// 当成本地目录,报出来却是「permission denied」那种误导性错误。
	remoteBase := d.RemotePath(a.cfg.RemoteBase)
	remote := path.Join(remoteBase, t.FileName.String)

	// Proton 的 session 操作必须串行 —— refresh_token 是一次性的,
	// 并发用会导致 Code=10013 账号永久砖化(记忆里的 proton-refresh-token-race)。
	//
	// 锁包住【整段】:建 runtime、mkdir、上传、收割、写回。任何一步漏在
	// 锁外,两个同账号任务就能同时拿着同一个 refresh_token 去认证。
	key := drive.Key(drive.Type(d.Type), t.UserID)
	return a.locks.WithSession(ctx, key, func() error {
		cfg, harvest, err := a.buildRuntime(ctx, d)
		if err != nil {
			return err
		}

		if err := a.rclone.Mkdir(ctx, cfg, remoteBase); err != nil {
			return fmt.Errorf("创建远端目录失败: %w", err)
		}
		if err := a.rclone.Upload(ctx, cfg, local, remote, nil); err != nil {
			return fmt.Errorf("上传失败: %w", err)
		}

		// 上传成功之后才收割并写回 session。
		//
		// 顺序不能反:rclone 在这次运行里已经把 refresh_token 换掉了,
		// 不回写的话下次拿旧 token 认证就是 Code=10013 —— 而 rclone
		// 那边不报错,只是把这个网盘静默变成用不了。
		if harvest != nil {
			if err := harvest(); err != nil {
				// 收割失败不该让整个任务判失败:文件已经传上去了。
				// 但必须显眼 —— 下一次上传就会因为 session 过期而失败。
				a.log.Error("收割 Proton session 失败,下次上传可能因 token 过期而失败",
					"taskId", t.ID, "err", err)
			}
		}

		// 【不要】把远端路径写回 source_ref。
		//
		// source_ref 是「这条消息从哪来」的引用,JS 侧靠它 JSON.parse
		// 出 messageId 去拉原始消息。覆盖成远端路径之后,回滚到 Node
		// 时这条任务会静默退化成「用 source_msg_id 兜底」—— 不报错,
		// 只是行为不对。JS 侧对 telegram 媒体也从不改写它。
		//
		// 上传成功才删本地。失败时保留 —— 排查和手工重试都要用。
		//
		// 不删的话容器磁盘(1GB)会被撑爆,而撑满之后是【所有】任务
		// 一起失败,不是单个任务 —— 排查时会往网盘方向找,实际是本地盘。
		_ = os.Remove(local)
		return nil
	})
}

// buildRuntime 为这次上传准备 rclone 的运行上下文。
//
// 两种网盘两种走法:
//   - 静态凭据(Mega):连接串就够,没有可收割的东西,harvest 返回 nil
//   - 可旋转 session(Proton):必须写临时 conf,跑完把新 token 读回来
//
// 后者不是可选项。连接串形式没有回读的余地 —— 参数传进去就没了,
// rclone 旋转出的新 refresh_token 只存在于它自己的临时状态里,
// 进程退出即丢失,而服务端那侧的旧 token 已经作废。
func (a *App) buildRuntime(ctx context.Context, d *drive.Drive) (rclone.Config, func() error, error) {
	if !d.WritableRuntime() {
		conn, err := drive.ToConnectionString(d)
		if err != nil {
			return rclone.Config{}, nil, err
		}
		return rclone.Config{Connection: conn, Timeout: 6 * time.Hour}, nil, nil
	}

	remoteName, entries, err := d.RuntimeEntries()
	if err != nil {
		return rclone.Config{}, nil, err
	}
	rt, err := rclone.NewRuntime(remoteName, entries)
	if err != nil {
		return rclone.Config{}, nil, err
	}

	harvest := func() error {
		// 先读后删 —— 反了就读不到旋转后的 token。
		defer rt.Dispose()

		section, err := rt.ReadSection()
		if err != nil {
			return err
		}
		next, changed := d.HarvestSession(section)
		if !changed {
			// rclone 没换 token。不写库 —— 少一次 D1 写,也少一次
			// 无谓的 updated_at 抖动。
			return nil
		}
		a.log.Info("Proton session 已旋转,写回数据库",
			"user", d.UserID, "drive", d.ID)
		return a.drives.UpdateConfigData(ctx, d.ID, d.UserID, next)
	}
	return rclone.Config{Runtime: rt, Timeout: 6 * time.Hour}, harvest, nil
}
