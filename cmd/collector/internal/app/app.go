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
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	"github.com/youngsx/drive-collector/cmd/collector/internal/task"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
	"github.com/youngsx/drive-collector/cmd/collector/internal/tgsession"
)

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
}

// App 是编排后的应用。
type App struct {
	tg     *tgclient.Client
	tasks  *task.Manager
	locks  *drive.SessionLock
	rclone *rclone.Runner
	repo   *store.Repository
	cfg    Config
	log    *slog.Logger
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
		cfg.DownloadDir = filepath.Join(os.TempDir(), "drive-collector")
	}

	a := &App{
		locks:  drive.NewSessionLock(),
		rclone: rclone.NewRunner(),
		repo:   cfg.Repo,
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
	a.tasks = manager
	return a, nil
}

// Run 启动并阻塞到 ctx 结束。
func (a *App) Run(ctx context.Context) error {
	if err := os.MkdirAll(a.cfg.DownloadDir, 0o755); err != nil {
		return fmt.Errorf("app: 创建下载目录失败: %w", err)
	}
	return a.tg.Run(ctx)
}

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

// onUpdate 收到 Telegram update 时创建任务。
//
// 只处理「带媒体的入站消息」—— 用户发文件或图片给 bot,建任务。
// 其他(update、callback、编辑)留给未来扩展,现在记一条 debug 就够:
// 猜错业务规则的风险远大于漏处理的风险。
func (a *App) onUpdate(ctx context.Context, u tgclient.Update) error {
	switch u.Kind {
	case tgclient.KindNewMessage, tgclient.KindMediaGroup:
		return a.createTaskFrom(ctx, u)
	default:
		a.log.Debug("暂不处理的 update", "kind", u.Kind, "pts", u.Pts)
		return nil
	}
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
		ID:          taskID,
		UserID:      fmt.Sprintf("%d", msg.SenderID),
		SourceType:  "telegram_media",
		FileName:    nullableString(msg.FileName),
		SourceRef:   nullableString(fmt.Sprintf("%d/%d", msg.ChatID, msg.ID)),
		MsgID:       nullableInt(int64(msg.ID)),
		SourceMsgID: nullableInt(int64(msg.GroupedID)),
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
	if err := a.tg.DownloadTo(ctx, chatID, msgID, dest, func(ratio float64) {
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

	// 驱动配置从哪来属于「用户绑定」范畴,暂由环境注入。
	// 这里只负责把它拼成连接串并调度 rclone。
	driveType := drive.Type(os.Getenv("DRIVE_TYPE"))
	if !drive.IsSupported(driveType) {
		return fmt.Errorf("网盘 %q 尚未实现(占位)", driveType)
	}
	conn, err := drive.ConnectionString(driveType, drive.Config{
		User: os.Getenv("DRIVE_USER"),
		Pass: os.Getenv("DRIVE_PASS"),
		Session: &drive.ProtonSession{
			ClientUID:           os.Getenv("PROTON_CLIENT_UID"),
			ClientAccessToken:   os.Getenv("PROTON_CLIENT_ACCESS_TOKEN"),
			ClientRefreshToken:  os.Getenv("PROTON_CLIENT_REFRESH_TOKEN"),
			ClientSaltedKeyPass: os.Getenv("PROTON_CLIENT_SALTED_KEY_PASS"),
		},
	})
	if err != nil {
		return err
	}

	cfg := rclone.Config{Connection: conn, Timeout: 6 * time.Hour}
	remote := filepath.Join(a.cfg.RemoteBase, t.FileName.String)

	if err := a.rclone.Mkdir(ctx, cfg, a.cfg.RemoteBase); err != nil {
		return fmt.Errorf("创建远端目录失败: %w", err)
	}

	// Proton 的 session 操作必须串行 —— refresh_token 是一次性的,
	// 并发用会导致 Code=10013 账号永久砖化(记忆里的 proton-refresh-token-race)。
	key := drive.Key(driveType, t.UserID)
	return a.locks.WithSession(ctx, key, func() error {
		if err := a.rclone.Upload(ctx, cfg, local, remote, nil); err != nil {
			return fmt.Errorf("上传失败: %w", err)
		}
		// 记下远端路径:出问题时能告诉用户文件原本该去哪。
		return a.repo.UpdateSourceRef(ctx, t.ID, remote)
	})
}
