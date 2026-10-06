package app

import (
	"context"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// Notifier 是「给用户发一句话」的能力。
//
// 抽接口的理由与 TaskRepo 相同:没绑盘的提示必须能测 —— 而真的发消息
// 需要连上 Telegram(要真实凭据,且会真的给用户发消息)。默认实现
// 就是 tg 客户端。
type Notifier interface {
	SendMessage(ctx context.Context, chatID int64, text string) error
}

// NoticeSender 是任务状态消息需要的三个动作。
//
// 抽接口只有一个理由:「文件投递后到底有没有回音」是本包最该断言的
// 事,而直接用 a.tg 的话测试里只有个空壳 Client,一调就 panic。
// 形状与 Notifier 相同,只是多了按钮和消息 id。
type NoticeSender interface {
	SendMessage(ctx context.Context, chatID int64, text string) error
	SendWithButtonsAndID(ctx context.Context, chatID int64, text string, buttons [][]tgclient.Button) (int, error)
	EditMessage(ctx context.Context, chatID int64, msgID int, text string) error
	EditWithButtons(ctx context.Context, chatID int64, msgID int, text string, buttons [][]tgclient.Button) error
}

// Downloader 是 download() 需要的 Telegram 下载能力。
//
// 抽接口而不是直接用 *telegram.Client:download 是「真正把用户文件
// 拉下来」的地方,恰恰是最该被测的 —— 而测它不需要真连 Telegram
// (那需要真实凭据,且会真的写文件)。
type Downloader interface {
	DownloadTo(ctx context.Context, chatID, msgID int64, destPath string, progress tgclient.ProgressFunc) error
}

// Rclone 是 upload() 与 /files 需要的网盘调度能力。
//
// 抽接口是因为 upload 的成败完全取决于它 —— 而具体实现要 spawn
// 真实二进制。测试用假实现就能断言「上传前先建目录」「失败要往上抛」。
type Rclone interface {
	Mkdir(ctx context.Context, cfg rclone.Config, remotePath string) error
	Upload(ctx context.Context, cfg rclone.Config, localPath, remotePath string, progress rclone.ProgressFunc) error
	ListFiles(ctx context.Context, cfg rclone.Config, remotePath string) ([]rclone.FileEntry, error)
	// ScanFiles 是 /scan_dup 专用:递归 + 内容哈希。判重没有哈希就退化成
	// 「按大小猜」,所以它必须是另一个方法而不是 ListFiles 的参数。
	ScanFiles(ctx context.Context, cfg rclone.Config, remotePath string) ([]rclone.FileEntry, error)
}

// MessageFetcher 是媒体组刷盘时重新取回消息的能力。
type MessageFetcher interface {
	FetchMessages(ctx context.Context, chatID int64, ids []int64) ([]tgclient.MessageInfo, error)
}

// TaskRepo 是 App 需要的任务仓储能力。
//
// 抽接口的唯一理由:download() 和 upload() 是「真正把用户文件搬来
// 搬去」的两行代码,却零测试 —— 而测它们需要能替换仓储。用具体
// *store.Repository 就得连真 D1,那测试没法跑。
//
// 只列 App 真正用到的方法。列全了会让每个 mock 都实现几十个。
type TaskRepo interface {
	Create(ctx context.Context, task store.Task) error
	CreateBatch(ctx context.Context, tasks []store.Task) error
	FindById(ctx context.Context, taskID string) (*store.Task, error)
	FindByUserId(ctx context.Context, userID string, limit int) ([]store.Task, error)
	FindByMsgId(ctx context.Context, msgID int64) (*store.Task, error)
	FindStalledTasks(ctx context.Context, timeout time.Duration) ([]store.Task, error)
	FindActiveByUserId(ctx context.Context, userID string, limit int) ([]store.Task, error)
	CountByUserStatus(ctx context.Context, userID string) (map[string]int, error)
	Transition(ctx context.Context, taskID string, ev contract.TaskEvent, errMsg *string) (store.TransitionResult, error)
	UpdateFileMetadata(ctx context.Context, taskID, fileName string, fileSize int64) error
}

// DriveRepo 是 upload() 需要的网盘仓储能力。
type DriveRepo interface {
	DefaultDrive(ctx context.Context, userID string) (*drive.Drive, error)
	// DrivesByUser 只被 /scan_dup 的「扫描所有网盘」用。
	DrivesByUser(ctx context.Context, userID string) ([]drive.Drive, error)
	DriveByID(ctx context.Context, id string) (*drive.Drive, error)
	// UpdateConfigData 写回网盘配置 —— 唯一用途是收割 Proton 旋转后的
	// session。不做这一步,那个网盘会在下一次上传时静默失效。
	UpdateConfigData(ctx context.Context, driveID, userID string, cfg drive.DriveConfig) error
}

// AdminRepo 是管理看板(/task_queue /users)与开关服务模式需要的仓储能力。
//
// 单独一个接口而不是并进 TaskRepo:这三个方法只被管理员命令用,
// 并进去会让每个已有 mock 都得多实现三个方法 —— 而它们跟转存主链路
// 毫无关系。
type AdminRepo interface {
	QueueOverview(ctx context.Context, limit int) (store.QueueOverview, error)
	TasksByStatus(ctx context.Context, status string, page, pageSize int) (store.TasksByStatus, error)
	ListUsersForAdmin(ctx context.Context, filter string, page, pageSize int, ownerID string) (store.AdminUsersPage, error)
	GetSetting(ctx context.Context, key, def string) (string, error)
	SetSetting(ctx context.Context, key, value string) error
}

// Authorizer 是 App 需要的权限判定能力。
//
// 与 dispatcher 里的同名接口一致 —— 两层各判各的,但语义必须一样。
// 抽接口而不是直接用 *auth.Guard:守卫是真·安全路径,而「管理员能不能
// 重试别人的任务」这类判定不接真 D1 就测不到。接了接口才能在测试里
// 真的把权限关掉,而不是靠「没装配就全放行」蒙混过关。
type Authorizer interface {
	Can(ctx context.Context, userID string, action auth.Action) (bool, error)
	IsBanned(ctx context.Context, userID string) (bool, error)
}

// 接口实现断言 —— 编译期保证真实实现满足它们。
// 少一个会在调用时才炸,而调用点是 upload(),症状是「上传全失败」。
var (
	_ TaskRepo       = (*store.Repository)(nil)
	_ DriveRepo      = (*store.DriveRepository)(nil)
	_ Downloader     = (*tgclient.Client)(nil)
	_ MessageFetcher = (*tgclient.Client)(nil)
	_ NoticeSender   = (*tgclient.Client)(nil)
	_ Rclone         = (*rclone.Runner)(nil)
	_ AdminRepo      = (*store.Repository)(nil)
	_ Authorizer     = (*auth.Guard)(nil)
)
