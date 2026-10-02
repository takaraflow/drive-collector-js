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
		locks:  drive.NewSessionLock(),
		rclone: rclone.NewRunner(),
		repo:   cfg.Repo,
		drives: cfg.Drives,
		cfg:    cfg,
		log:    cfg.Log,
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
	go a.recoverOnStart(ctx)

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

// recoverOnStart 捞回上次运行的遗留物。
//
// 两个都是「重启后会静默消失」的东西:
//   - 媒体组:定时器全在内存里,进程一死组就卡在缓冲里不刷
//   - 僵尸任务:停在 downloading/uploading,用户永远等不到结果
func (a *App) recoverOnStart(ctx context.Context) {
	// 媒体组
	if n, err := a.mediaGroups.Restore(ctx); err != nil {
		a.log.Warn("捞回遗留媒体组失败", "err", err)
	} else if n > 0 {
		a.log.Info("已捞回遗留媒体组", "组数", n)
	}

	// 僵尸任务:重置为 queued,让随后的 webhook 重新处理。
	stalled, err := a.repo.FindStalledTasks(ctx, StalledThreshold)
	if err != nil {
		a.log.Warn("查询僵尸任务失败", "err", err)
		return
	}
	if len(stalled) == 0 {
		return
	}

	reset := 0
	for _, tsk := range stalled {
		if _, terr := a.repo.Transition(ctx, tsk.ID, contract.EventResetStalled, nil); terr != nil {
			a.log.Warn("重置僵尸任务失败", "taskId", tsk.ID, "err", terr)
			continue
		}
		reset++
	}
	a.log.Info("已重置僵尸任务", "数量", reset)
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
		SourceRef:  nullableString(fmt.Sprintf("%d/%d", msg.ChatID, msg.ID)),
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
	return nil
}

// download 把 Telegram 文件拉到本地。
func (a *App) download(ctx context.Context, t store.Task) error {
	if !t.SourceRef.Valid || t.SourceRef.String == "" {
		return fmt.Errorf("任务 %s 没有源引用", t.ID)
	}
	var chatID, msgID int64
	if _, err := fmt.Sscanf(t.SourceRef.String, "%d/%d", &chatID, &msgID); err != nil {
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

	conn, err := drive.ToConnectionString(d)
	if err != nil {
		return err
	}

	cfg := rclone.Config{Connection: conn, Timeout: 6 * time.Hour}
	// 用户在 UI 里设的目录优先,退回全局默认。
	remoteBase := d.RemotePath(a.cfg.RemoteBase)
	remote := filepath.Join(remoteBase, t.FileName.String)

	if err := a.rclone.Mkdir(ctx, cfg, remoteBase); err != nil {
		return fmt.Errorf("创建远端目录失败: %w", err)
	}

	// Proton 的 session 操作必须串行 —— refresh_token 是一次性的,
	// 并发用会导致 Code=10013 账号永久砖化(记忆里的 proton-refresh-token-race)。
	key := drive.Key(drive.Type(d.Type), t.UserID)
	return a.locks.WithSession(ctx, key, func() error {
		if err := a.rclone.Upload(ctx, cfg, local, remote, nil); err != nil {
			return fmt.Errorf("上传失败: %w", err)
		}
		// 记下远端路径:出问题时能告诉用户文件原本该去哪。
		return a.repo.UpdateSourceRef(ctx, t.ID, remote)
	})
}
