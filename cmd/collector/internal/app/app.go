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
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"

	"github.com/youngsx/drive-collector/cmd/collector/internal/bindingsession"
	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/d1"
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

	// D1 是绑定向导写 drives 表用的。nil 时绑定流程只读(绑定禁用)。
	D1 *d1.Client

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
	// admin 是管理看板(/task_queue /users)与访问模式开关用的仓储。
	// 与 repo 分开是因为接口面不同 —— 前者是转存主链路,后者只服务
	// 管理员命令。测试时各自替换,互不牵连。
	admin AdminRepo
	// ownerID 是配置里的 owner telegram id;/users 用它标出所有者。
	ownerID    string
	dispatcher *dispatcher.Dispatcher
	// auth 是 RBAC 判定。为 nil 时一律放行 —— 没装配 Auth 就没有
	// 角色概念,此时拦截只会把所有人挡在门外。
	// 「只有管理员能做」的判定走 canAdmin,它在 nil 时返回 false。
	auth Authorizer
	// notifier 默认是 tg;测试注入假实现 —— 没绑盘的提示是本包
	// 唯一会给用户发消息的地方,必须能测。
	notifier Notifier
	// notices 是任务状态消息的收发通道。默认也是 tg,但必须能换成
	// 假实现:「发完文件有没有回音」正是本包最该断言的事,而真的
	// tg 发消息要真实凭据、还会真的打扰用户。
	// 为 nil 时(postNotice/notify)静默跳过 —— 只可能发生在没装配
	// 的测试里,生产一定会设。
	notices NoticeSender
	// 绑定向导的依赖。bindSessions 为 nil 时绑定流程整体禁用
	// (handleBindInput 直接放行消息,不当成向导输入)。
	bindSessions *bindingsession.Store
	bindRuntime  drive.ProtonRuntime
	// rcloneRunner 是绑定向导验证凭据用的执行器(rclone 的另一个引用)。
	rcloneRunner *rclone.Runner
	// d1 是绑定向导写 drives 表用的;为 nil 时绑定写入禁用。
	d1c *d1.Client
	cfg Config
	log *slog.Logger

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

	// runningMu/running 是「谁正在跑」的账本,见 queue.go 顶部。
	// 取消按钮和封禁都要靠它找到「现在该掐谁」—— 没有它,取消就只能
	// 改数据库状态,进程照跑到底。
	runningMu sync.Mutex
	running   map[string]*runningTask

	// filesMu 保护下面两个 /files 的内存层状态(与 JS 侧 localCache
	// + filesRefreshTimes 对应)。
	filesMu sync.Mutex
	// filesMem 是清单的内存缓存:key 与 Redis 层同格式,过期时间按
	// 文件新鲜度动态算(见 optimalFilesTTL)。
	filesMem map[string]filesMemEntry
	// filesRefreshAt 是刷新冷却的上次刷新时刻,key 是 "<user>:<msgID>"。
	// ponytail: 与 JS 侧一样只增不清,量级是「每用户每条消息一次」,
	// 真成了内存问题再按时间窗清理。
	filesRefreshAt map[string]time.Time

	// modeMu/modeCached 保护访问模式的进程内缓存 —— 全局守卫每条
	// 消息都要读一次,不缓存就是每条消息一次 D1 往返。
	modeMu       sync.Mutex
	modeCached   string
	modeCachedAt time.Time
}

// filesMemEntry 是内存缓存的一条。
type filesMemEntry struct {
	files   []rclone.FileEntry
	expires time.Time
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

	runner := rclone.NewRunner()
	// Auth 为 nil 是允许的(没装配权限层就没有角色概念),所以 ownerID
	// 要单独取 —— 直接 cfg.Auth.OwnerID() 会在 nil 上炸,炸的还是构造期。
	ownerID := ""
	if cfg.Auth != nil {
		ownerID = cfg.Auth.OwnerID()
	}
	a := &App{
		locks:          drive.NewSessionLock(),
		rclone:         runner,
		repo:           cfg.Repo,
		drives:         cfg.Drives,
		admin:          cfg.Repo,
		ownerID:        ownerID,
		rcloneRunner:   runner,
		cfg:            cfg,
		log:            cfg.Log,
		pending:        make(chan string, pendingQueueSize),
		filesMem:       map[string]filesMemEntry{},
		filesRefreshAt: map[string]time.Time{},
	}

	// 绑定向导:Redis(会话存储)和 D1(落库)都在才装配。
	// 缺一个就整体禁用 —— 半套向导比没有向导更害人。
	if cfg.Redis != nil && cfg.D1 != nil {
		a.bindSessions = bindingsession.NewStore(cfg.Redis)
		a.d1c = cfg.D1
		drive.SetObscureRunner(a.rcloneRunner)
		a.bindRuntime = newProtonRuntime(a.rcloneRunner)
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
	a.notifier = tg
	a.notices = tg
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
	// 只在真的装配了 Auth 时才赋给接口字段:把 nil 的 *auth.Guard 塞进
	// 接口会得到一个「非 nil 的接口包着 nil 指针」,于是 a.auth == nil
	// 为假,canAdmin 会走进真调用然后在 nil 接收者上炸。
	if cfg.Auth != nil {
		a.auth = cfg.Auth
		a.dispatcher = dispatcher.New(dispatcher.Deps{
			Telegram: tg,
			Auth:     cfg.Auth,
			Renders:  a,
			Log:      cfg.Log,
			// Sessions 传 a 自己:封禁成功后要清掉被封用户的绑定
			// 会话(里面有密码)。App 是唯一知道有哪些会话的地方。
			Sessions: a,
		})
	}
	return a, nil
}

// Run 启动并阻塞到 ctx 结束。
func (a *App) Run(ctx context.Context) error {
	// 清掉上次运行残留的下载文件。
	//
	// 正常路径下 upload 的 defer 已经把文件删干净了(成功失败都删),
	// 这里兜的是「进程被 SIGKILL/断电,defer 没来得及跑」那一类 ——
	// 残留会随着重跑的任务越积越多。
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
	// 全局守卫先行 —— 与 JS 侧 _globalGuard 同一位置、同一顺序:
	// 黑名单最高优先级(连 owner 也不例外),维护模式次之。
	//
	// 必须在这里而不是 Dispatcher 里:app 自己接管的命令(/files /drive
	// /status 管理看板)根本不经过 Dispatcher,守卫放里面就等于这些命令
	// 对封禁用户和普通用户全部敞开。
	if done, err := a.globalGuard(ctx, u); done || err != nil {
		return err
	}

	switch u.Kind {
	case tgclient.KindCallbackQuery:
		return a.handleCallback(ctx, u)

	case tgclient.KindNewMessage, tgclient.KindMediaGroup:
		msg, ok := messageOf(u)
		if !ok {
			return nil
		}

		// 自己发出的消息不是用户投递,必须在任何处理之前丢弃 ——
		// 包括那条「收到消息」日志。
		//
		// gotd 发消息的收尾就是 processUpdates(telegram/send_message.go),
		// 所以 bot 每次回复都会有一条 Out=true 的合成消息绕回这里
		// (upconv.ShortSentMessage 只填 ID/Date/Out,没有 PeerID)。
		// 生产现场就是日志里紧跟「命令已处理」的一条
		// 「收到消息 chatId:0 senderId:0 text:""」。
		//
		// 现在它只是噪音,但合成消息可以带媒体 —— 那时就会用
		// user_id=0 建任务,文件下载完因为「用户 0 没有绑定网盘」
		// 永远传不上去,而日志里一切正常。
		//
		// JS 侧同样在入口丢弃(MessageHandler.handleEvent 的
		// message.out === true),这里保持一致。
		if msg.Out {
			a.log.Debug("跳过自己发出的消息", "msgId", msg.ID)
			return nil
		}

		// 到达日志。级别是 Info 而不是 Debug —— 排「发消息没反应」时,
		// 「消息到了但后续分支出错」和「消息压根没到」在日志里必须能分开,
		// Debug 级在生产默认不可见,等于没记。
		a.log.Info("收到消息",
			"msgId", msg.ID, "chatId", msg.ChatID,
			"senderId", msg.SenderID, "hasMedia", msg.HasMedia,
			"text", truncate(msg.Text, 64))

		// 命令优先:带媒体的消息里也可能带 / 开头的内容,
		// 但命令是用户明确的意图,不能被当成文件投递。
		if strings.HasPrefix(strings.TrimSpace(msg.Text), "/") {
			// 绑定会话的取消指令(/cancel)要先于命令路由 —— 会话里
			// /cancel 不是通用命令,是「退出向导」。
			if a.handleBindInput(ctx, msg, strings.TrimSpace(msg.Text)) {
				return nil
			}
			return a.routeCommand(ctx, msg)
		}

		// 绑定会话进行中:任何文本都是向导的输入(邮箱/密码/2FA 码),
		// 不再当普通聊天内容。
		if a.handleBindInput(ctx, msg, msg.Text) {
			return nil
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
//
// 绑定命令(/drive /unbind /set_remote_folder /cancel)和 /files 在进
// Dispatcher 之前拦截 —— 它们要么要写会话/落库,要么要读网盘凭据跑
// rclone,Dispatcher 的接口面(只读权限+任务)不够用。其余命令照旧
// 走 Dispatcher。
func (a *App) routeCommand(ctx context.Context, msg messageInfo) error {
	text := strings.TrimSpace(msg.Text)
	command := strings.ToLower(strings.Fields(text)[0])

	switch command {
	case "/drive":
		return a.handleDriveCommand(ctx, msg)
	case "/unbind", "/logout":
		return a.handleUnbindCommand(ctx, msg)
	case "/set_remote_folder", "/remote_folder":
		return a.handleRemoteFolderCommand(ctx, msg)
	case "/files":
		return a.handleFilesCommand(ctx, msg)
	case "/status":
		return a.handleStatusCommand(ctx, msg)
	case "/scan_dup":
		return a.handleScanDupCommand(ctx, msg)

	// 管理看板。放在 Dispatcher 之前的原因与 /status 相同:重试失败
	// 任务要写状态机,而 Dispatcher 的接口面只有只读权限。
	case "/task_queue":
		return a.handleTaskQueueCommand(ctx, msg)
	case "/users":
		return a.handleAdminUsersCommand(ctx, msg)
	case "/diagnosis":
		return a.handleDiagnosisCommand(ctx, msg)

	// 服务模式开关。/open_service ≡ /status_public、/close_service ≡
	// /status_private —— 与 Dispatcher.adminAliases 里的映射一致。
	case "/status_public", "/open_service":
		return a.handleModeSwitchCommand(ctx, msg, store.AccessModePublic)
	case "/status_private", "/close_service":
		return a.handleModeSwitchCommand(ctx, msg, store.AccessModePrivate)
	}

	if a.dispatcher == nil {
		// dispatcher 没装配是配置事故,不是「没什么可做」——
		// 之前记成 Debug,而生产是 Info 级,于是「机器人装死」和
		// 「消息没到」在日志里完全一样。
		a.log.Error("命令被丢弃:dispatcher 未装配", "text", msg.Text)
		return nil
	}
	handled, err := a.dispatcher.HandleText(ctx, msg.ChatID, fmt.Sprintf("%d", msg.SenderID), msg.Text)
	if err != nil {
		// 命令处理失败不该让客户端重连 —— 否则一条坏命令会变成
		// 断线重连风暴。记日志就好。
		a.log.Error("命令处理失败", "text", msg.Text, "err", err)
		return nil
	}
	// 成功也要记。用户报「发消息没反应」时,这条是唯一能区分
	// 「命令跑完了但用户没收到」和「命令根本没跑」的证据。
	a.log.Info("命令已处理", "text", msg.Text, "handled", handled)
	return nil
}

// handleDriveCommand /drive —— 发绑定面板(带类型选择按钮)。
func (a *App) handleDriveCommand(ctx context.Context, msg messageInfo) error {
	userID := fmt.Sprintf("%d", msg.SenderID)
	if !a.bindDriveReady() {
		return a.tg.SendMessage(ctx, msg.ChatID,
			"⚠️ 网盘绑定在新服务上暂不可用,请稍后再试或联系管理员。")
	}

	drives, err := a.drivesList(ctx, userID)
	if err != nil {
		a.log.Error("查询网盘失败", "err", err)
	}
	text := "🛠️ <b>网盘管理中心</b>\n\n"
	if len(drives) > 0 {
		text += "已绑定的网盘:\n"
		for i := range drives {
			d := &drives[i]
			icon := "📁"
			if d.IsDefault == 1 {
				icon = "⭐️"
			}
			email := driveDisplayAccount(d)
			text += fmt.Sprintf("\n%d. %s <b>%s</b> - %s", i+1, icon, strings.ToUpper(d.Type), email)
			if d.IsDefault == 1 {
				text += " (默认)"
			}
		}
		text += "\n"
	} else {
		text += "目前尚未绑定任何网盘。请选择下方服务开始绑定："
	}

	buttons := [][]tgclient.Button{
		{{Text: "🟢 Mega", Data: "drive_bind_mega"}},
		{{Text: "🛡️ Proton Drive", Data: "drive_bind_protondrive"}},
	}
	for i := range drives {
		d := &drives[i]
		row := []tgclient.Button{}
		if d.IsDefault != 1 {
			row = append(row, tgclient.Button{
				Text: fmt.Sprintf("%d 设为默认", i+1), Data: "drive_set_default_" + d.ID})
		}
		row = append(row, tgclient.Button{Text: fmt.Sprintf("%d ❌ 解绑", i+1), Data: "drive_unbind_confirm_" + d.ID})
		buttons = append(buttons, row)
	}
	buttons = append(buttons, []tgclient.Button{{Text: "❌ 返回", Data: "noop"}})
	return a.tg.SendWithButtons(ctx, msg.ChatID, text, buttons)
}

// driveDisplayAccount 从盘名里截出账号部分(JS 侧 name.split('-').slice(1) 的等价)。
func driveDisplayAccount(d *drive.Drive) string {
	if d == nil || d.Name == "" {
		return "未知账号"
	}
	parts := strings.SplitN(d.Name, "-", 2)
	if len(parts) > 1 && parts[1] != "" {
		return parts[1]
	}
	return d.Name
}

// handleUnbindCommand /unbind —— 删用户全部网盘(带确认,见 /unbind 的按钮流)。
func (a *App) handleUnbindCommand(ctx context.Context, msg messageInfo) error {
	// 简化版:直接列出面板让用户逐个解绑 —— 全量解绑是低频操作,
	// 按钮确认链路先省,误删风险由「逐个 + 确认按钮」兜住。
	return a.handleDriveCommand(ctx, msg)
}

// handleRemoteFolderCommand /set_remote_folder /path —— 真正写库。
func (a *App) handleRemoteFolderCommand(ctx context.Context, msg messageInfo) error {
	userID := fmt.Sprintf("%d", msg.SenderID)
	fields := strings.Fields(strings.TrimSpace(msg.Text))
	if len(fields) < 2 {
		return a.tg.SendMessage(ctx, msg.ChatID,
			"用法:<code>/set_remote_folder /你的目录</code>\n\n"+
				"例如:<code>/set_remote_folder /backup</code>")
	}
	folder := strings.Join(fields[1:], " ")
	if !a.bindDriveReady() {
		return a.tg.SendMessage(ctx, msg.ChatID, "⚠️ 该功能暂未迁移到新服务。")
	}
	if err := a.setRemoteFolder(ctx, userID, "", folder); err != nil {
		a.log.Error("设置保存目录失败", "err", err)
		return a.tg.SendMessage(ctx, msg.ChatID, "❌ 设置失败:"+escapeHTMLText(err.Error()))
	}
	return a.tg.SendMessage(ctx, msg.ChatID,
		"✅ 保存目录已设为 <code>"+escapeHTMLText(folder)+"</code>")
}

func escapeHTMLText(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}

// handleCallback 处理按钮点击 —— 绑定面板与 /files 翻页的全部交互都在这。
func (a *App) handleCallback(ctx context.Context, u tgclient.Update) error {
	cb, ok := tgclient.CallbackOf(u)
	if !ok {
		return nil
	}
	userID := fmt.Sprintf("%d", cb.UserID)
	data := cb.Data

	// 无论如何都要回应 —— 不回应客户端会一直转圈。
	answer := func(text string, alert bool) {
		if err := a.tg.AnswerCallback(ctx, cb.CallbackID, text, alert); err != nil {
			a.log.Warn("回应按钮失败", "err", err)
		}
	}

	switch {
	case strings.HasPrefix(data, "drive_bind_"):
		answer("开始绑定", false)
		return a.bindStart(ctx, cb.ChatID, userID, strings.TrimPrefix(data, "drive_bind_"))

	case strings.HasPrefix(data, "drive_unbind_confirm_"):
		driveID := strings.TrimPrefix(data, "drive_unbind_confirm_")
		buttons := [][]tgclient.Button{
			{{Text: "保留网盘", Data: "drive_manager_back"}},
			{{Text: "确认解绑", Data: "drive_unbind_execute_" + driveID}},
		}
		answer("请确认", false)
		return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID,
			"⚠️ 确定要解绑这个网盘吗？解绑后需要重新绑定才能继续转存。", buttons)

	case strings.HasPrefix(data, "drive_unbind_execute_"):
		driveID := strings.TrimPrefix(data, "drive_unbind_execute_")
		if err := a.deleteDrive(ctx, userID, driveID); err != nil {
			a.log.Error("解绑失败", "driveId", driveID, "err", err)
			answer("解绑失败", true)
			return nil
		}
		answer("已解绑", false)
		return a.editDriveManager(ctx, cb)

	case strings.HasPrefix(data, "drive_set_default_"):
		driveID := strings.TrimPrefix(data, "drive_set_default_")
		if err := a.setDefault(ctx, userID, driveID); err != nil {
			a.log.Error("设默认盘失败", "err", err)
			answer("设置失败", true)
			return nil
		}
		answer("已设为默认", false)
		return a.editDriveManager(ctx, cb)

	case data == "drive_manager_back" || data == "noop":
		if data == "noop" {
			answer("", false)
			return nil
		}
		answer("已返回", false)
		return a.editDriveManager(ctx, cb)

	case strings.HasPrefix(data, "files_page_"), strings.HasPrefix(data, "files_refresh_"):
		// 回应交给 files 流程的末尾(与 JS 一致:成功的刷新答「刷新成功」,
		// 限流答剩余秒数)—— 这里先答会把那次回应作废。
		return a.handleFilesCallback(ctx, cb, data)

	case strings.HasPrefix(data, "cancel_confirm_"), strings.HasPrefix(data, "cancel_execute_"),
		strings.HasPrefix(data, "retry_confirm_"), strings.HasPrefix(data, "retry_execute_"),
		data == "task_action_back", data == "status_general":
		return a.handleStatusCallback(ctx, cb, data)

	case data == "remote_folder_menu":
		// /status 里的「设置保存路径」入口:告诉用户当前目录 + 怎么改。
		answer("", false)
		return a.editRemoteFolderMenu(ctx, cb)

	// 管理看板的入口按钮(挂在 /status 顶部)与看板内部按钮。
	case data == "task_queue_open":
		answer("", false)
		return a.openTaskQueue(ctx, cb)

	case data == "admin_users_open":
		answer("", false)
		return a.openAdminUsers(ctx, cb)

	case data == "diagnosis_run":
		answer("正在诊断", false)
		return a.editDiagnosisReport(ctx, cb.ChatID, cb.MsgID)

	case strings.HasPrefix(data, "tq_"), strings.HasPrefix(data, "retry_failed_page_"):
		return a.handleTaskQueueCallback(ctx, cb, data)

	case strings.HasPrefix(data, "au_"), data == "admin_users_back":
		return a.handleAdminUsersCallback(ctx, cb, data)

	case strings.HasPrefix(data, "mode_switch_"):
		return a.handleModeSwitchCallback(ctx, cb, data)

	case strings.HasPrefix(data, "dupscan_"):
		return a.handleDupScanCallback(ctx, cb, data)
	}

	a.log.Debug("收到未处理的按钮点击", "data", data)
	answer("该功能暂未迁移", false)
	return nil
}

// editDriveManager 重绘网盘管理面板(解绑/设默认后刷新列表)。
func (a *App) editDriveManager(ctx context.Context, cb tgclient.CallbackContext) error {
	userID := fmt.Sprintf("%d", cb.UserID)
	drives, err := a.drivesList(ctx, userID)
	if err != nil {
		return a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, "加载网盘列表失败,请重试。")
	}
	text := "🛠️ <b>网盘管理中心</b>\n\n"
	if len(drives) > 0 {
		text += "已绑定的网盘:\n"
		for i := range drives {
			d := &drives[i]
			icon := "📁"
			if d.IsDefault == 1 {
				icon = "⭐️"
			}
			text += fmt.Sprintf("\n%d. %s <b>%s</b> - %s", i+1, icon,
				strings.ToUpper(d.Type), driveDisplayAccount(d))
			if d.IsDefault == 1 {
				text += " (默认)"
			}
		}
		text += "\n"
	} else {
		text += "目前尚未绑定任何网盘。请选择下方服务开始绑定："
	}

	buttons := [][]tgclient.Button{}
	for i := range drives {
		d := &drives[i]
		row := []tgclient.Button{}
		if d.IsDefault != 1 {
			row = append(row, tgclient.Button{Text: fmt.Sprintf("%d 设为默认", i+1), Data: "drive_set_default_" + d.ID})
		}
		row = append(row, tgclient.Button{Text: fmt.Sprintf("%d ❌ 解绑", i+1), Data: "drive_unbind_confirm_" + d.ID})
		buttons = append(buttons, row)
	}
	buttons = append(buttons, []tgclient.Button{{Text: "➕ 绑定其他网盘", Data: "noop"}})
	return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, text, buttons)
}

// noDriveHint 与 JS 侧 STRINGS.drive.no_drive_found 逐字一致。
//
// 逐字一致是刻意的:切换期两边可能同时在跑,用户看到的应该是同一句话;
// 排查时也不必先分辨「这是哪个实现说的」。
const noDriveHint = "🚫 <b>还没有绑定网盘</b>\n\n请先绑定网盘,然后再发送文件或链接。"

// requireDrive 检查用户有没有可用网盘;没有就提示并返回 false。
//
// 与 JS 侧 _handleMediaMessage 一致:没绑盘时不建任务、不下载,直接提示。
//
// 不检查的代价不是「任务失败」那么轻:文件会先被【完整下载】下来
// (浪费带宽和磁盘),上传阶段才报「用户 X 没有绑定网盘」—— 而用户
// 那边一个字都收不到,只看到「发了文件没反应」。这正是最难排查的
// 那类静默故障。
func (a *App) requireDrive(ctx context.Context, chatID, userID int64) bool {
	d, err := a.drives.DefaultDrive(ctx, fmt.Sprintf("%d", userID))
	if err != nil {
		// 查询失败 ≠ 没绑盘。这里【放行】:拦下来会把「数据库抖了一下」
		// 变成「用户不能转存」,而且提示还是错的。真没盘的话,上传
		// 阶段会再查一次并让任务带着明确错误失败。
		a.log.Error("查询用户网盘失败,放行建任务", "userId", userID, "err", err)
		return true
	}
	if d != nil {
		return true
	}

	if err := a.notifier.SendMessage(ctx, chatID, noDriveHint); err != nil {
		// 提示发不出去不该升级成别的 —— 任务本来就没建,用户下次
		// 发文件会再收到一次提示。
		a.log.Error("发送绑盘提示失败", "chatId", chatID, "err", err)
	}
	a.log.Info("用户未绑定网盘,任务不建", "userId", userID, "chatId", chatID)
	return false
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

	// 没绑盘就不建任务,先提示去绑定 —— 与 JS 侧 _handleMediaMessage 一致。
	if !a.requireDrive(ctx, msg.ChatID, msg.SenderID) {
		return nil
	}

	taskID := newTaskID()

	// 先发状态消息,再落库 —— 用户投递文件后必须立刻看到回音。
	// 建完任务直接入队、一句话不发的话,用户那边就是「发了文件只有
	// 已读」:任务在后台跑完了他也不知道成功还是失败。
	noticeID := a.postNotice(ctx, msg.ChatID, taskID)

	t := store.Task{
		ID:         taskID,
		UserID:     fmt.Sprintf("%d", msg.SenderID),
		ChatID:     nullableString(fmt.Sprintf("%d", msg.ChatID)),
		SourceType: "telegram_media",
		FileName:   nullableString(msg.FileName),
		SourceRef:  nullableString(BuildSourceRef(msg.ChatID, int64(msg.ID))),
		// MsgID 是 bot 自己那条状态消息 —— 后面每个阶段都编辑它。
		// 以前这里写的是 msg.ID(用户发来的那条),于是所有针对任务
		// 的编辑都会落到用户的文件消息上。
		MsgID: nullableInt(int64(noticeID)),
		// SourceMsgID 是【被转存的那条消息】。曾经写成 msg.SourceMsgID
		// (那是 Telegram 的 forwarded-from 字段,私聊里恒为空),
		// 于是「这条任务是从哪条消息来的」永远查不到 —— 不报错,
		// 只是没人查得到。语义与 JS 侧 addTask 的 sourceMsgId 一致。
		SourceMsgID: nullableInt(int64(msg.ID)),
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
		// 半截文件必须删。任务被取消/失败时后续流程不会执行,这个残file
		// 就留在下载目录里 —— 而 recoverOnStart 会把这类任务重新排队,
		// 重跑会重新下载,留着那份没有任何用处,只会一路堆积。
		_ = os.Remove(dest)
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

	// 本地文件【无条件】删,成功失败都删。
	//
	// 原先只在上传成功后删,失败/被取消的就留在盘上 —— 但没有任何代码
	// 读它(排查靠的是任务表里的 error_msg 和文件大小,不是这个文件),
	// 而这些任务会被 recoverOnStart 重新排队重跑,重跑会重新下载。
	// 留着那份没有任何用处,只会随着失败次数一路堆积。
	defer func() { _ = os.Remove(local) }()

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
		// 临时 conf 目录【无条件】清,和成功无关。
		//
		// harvest 里那个 defer Dispose 只在「走到收割」时才跑;任务被取消
		// 或中途失败时 harvest 根本不会被调用,/tmp/rclone-rt-*(内含 0600
		// 的 session 凭据)就留在盘上。Dispose 幂等,重复调无害。
		if cfg.Runtime != nil {
			defer cfg.Runtime.Dispose()
		}

		// 收割也【无条件】做 —— 不只是上传成功之后。
		//
		// rclone 在被 kill 之前很可能已经把 refresh_token 换掉了,而
		// 服务端那侧的旧 token 随即作废。不回写的话库里那份就是死的,
		// 下次认证 Code=10013,账号永久砖化(记忆里的 proton-refresh-token-race)。
		// 以前这里只在成功路径跑,是因为以前取消【不会真的杀进程】——
		// 现在会了,不补这一刀就是拿「能取消」换「能砖账号」。
		//
		// 用 WithoutCancel:出问题时 ctx 往往正是被掐掉的那条,拿它写库
		// 必然失败,而这次写库恰恰是唯一能救账号的机会。
		//
		// 无变化时 harvest 内部直接返回,不会多写一次库。
		if harvest != nil {
			defer func() {
				// 收割失败不该让任务判失败:文件要么已经传上去了,要么
				// 任务本来就是失败的。但必须显眼 —— 下一次上传就会因为
				// session 过期而失败。
				if err := harvest(); err != nil {
					a.log.Error("收割 Proton session 失败,下次上传可能因 token 过期而失败",
						"taskId", t.ID, "err", err)
				}
			}()
		}

		if err := a.rclone.Mkdir(ctx, cfg, remoteBase); err != nil {
			return fmt.Errorf("创建远端目录失败: %w", err)
		}
		if err := a.rclone.Upload(ctx, cfg, local, remote, nil); err != nil {
			return fmt.Errorf("上传失败: %w", err)
		}

		// 【不要】把远端路径写回 source_ref。
		//
		// source_ref 是「这条消息从哪来」的引用,JS 侧靠它 JSON.parse
		// 出 messageId 去拉原始消息。覆盖成远端路径之后,回滚到 Node
		// 时这条任务会静默退化成「用 source_msg_id 兜底」—— 不报错,
		// 只是行为不对。JS 侧对 telegram 媒体也从不改写它。
		//
		// 本地文件的删除在函数出口的 defer 里(成功失败都删),原因见那里。
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
		// WithoutCancel:upload 现在无条件收割,包括任务被取消/上传失败的
		// 那种 —— 那时 ctx 已经死了,拿它写库必然失败,而这次写库恰恰
		// 是唯一能救账号的机会(旧 refresh_token 已被服务端作废)。
		return a.drives.UpdateConfigData(context.WithoutCancel(ctx), d.ID, d.UserID, next)
	}
	return rclone.Config{Runtime: rt, Timeout: 6 * time.Hour}, harvest, nil
}
