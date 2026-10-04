package app

import (
	"context"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// Downloader 是 download() 需要的 Telegram 下载能力。
//
// 抽接口而不是直接用 *telegram.Client:download 是「真正把用户文件
// 拉下来」的地方,恰恰是最该被测的 —— 而测它不需要真连 Telegram
// (那需要真实凭据,且会真的写文件)。
type Downloader interface {
	DownloadTo(ctx context.Context, chatID, msgID int64, destPath string, progress tgclient.ProgressFunc) error
}

// Rclone 是 upload() 需要的网盘调度能力。
//
// 抽接口是因为 upload 的成败完全取决于它 —— 而具体实现要 spawn
// 真实二进制。测试用假实现就能断言「上传前先建目录」「失败要往上抛」。
type Rclone interface {
	Mkdir(ctx context.Context, cfg rclone.Config, remotePath string) error
	Upload(ctx context.Context, cfg rclone.Config, localPath, remotePath string, progress rclone.ProgressFunc) error
}

// Rclone 是 upload() 需要的网盘调度能力。
//
// 抽接口是因为 upload 的成败完全取决于它 —— 而具体实现要 spawn
// 真实二进制。测试用假实现就能断言「上传前先建目录」「失败要往上抛」。
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
	Transition(ctx context.Context, taskID string, ev contract.TaskEvent, errMsg *string) (store.TransitionResult, error)
	UpdateFileMetadata(ctx context.Context, taskID, fileName string, fileSize int64) error
}

// DriveRepo 是 upload() 需要的网盘仓储能力。
type DriveRepo interface {
	DefaultDrive(ctx context.Context, userID string) (*drive.Drive, error)
	DriveByID(ctx context.Context, id string) (*drive.Drive, error)
}

// 接口实现断言 —— 编译期保证真实实现满足它们。
// 少一个会在调用时才炸,而调用点是 upload(),症状是「上传全失败」。
var (
	_ TaskRepo       = (*store.Repository)(nil)
	_ DriveRepo      = (*store.DriveRepository)(nil)
	_ Downloader     = (*tgclient.Client)(nil)
	_ MessageFetcher = (*tgclient.Client)(nil)
	_ Rclone         = (*rclone.Runner)(nil)
)
