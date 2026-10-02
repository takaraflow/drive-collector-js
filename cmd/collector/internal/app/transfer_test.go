package app

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// ============================================================================
// download() / upload() 是「真正把用户文件搬来搬去」的两行代码。
// 在补这些测试之前它们的覆盖率是 0 —— 而它们出问题就是用户的文件
// 传不上去。下面每个用例都对应一个真实故障模式。
// ============================================================================

// fakeDL 代替真 Telegram 下载。
type fakeDL struct {
	calls   int
	chatID  int64
	msgID   int64
	dest    string
	content string
	err     error
}

func (f *fakeDL) DownloadTo(_ context.Context, chatID, msgID int64, dest string, _ tgclient.ProgressFunc) error {
	f.calls++
	f.chatID, f.msgID, f.dest = chatID, msgID, dest
	if f.err != nil {
		return f.err
	}
	return os.WriteFile(dest, []byte(f.content), 0o644)
}

// fakeRepo 记录仓储调用并返回预设结果。
type fakeRepo struct {
	created    []store.Task
	batch      []store.Task
	stalled    []store.Task
	trans      []contract.TaskEvent
	fileSize   int64
	fileName   string
	srcRef     string
	createErr  error
	batchErr   error
	stalledErr error
}

func (f *fakeRepo) Create(_ context.Context, t store.Task) error {
	if f.createErr != nil {
		return f.createErr
	}
	f.created = append(f.created, t)
	return nil
}

func (f *fakeRepo) CreateBatch(_ context.Context, ts []store.Task) error {
	if f.batchErr != nil {
		return f.batchErr
	}
	f.batch = append(f.batch, ts...)
	return nil
}

func (f *fakeRepo) FindById(context.Context, string) (*store.Task, error) { return nil, nil }

func (f *fakeRepo) FindByUserId(context.Context, string, int) ([]store.Task, error) {
	return nil, nil
}

func (f *fakeRepo) FindByMsgId(context.Context, int64) (*store.Task, error) {
	return nil, nil
}

func (f *fakeRepo) FindStalledTasks(_ context.Context, _ time.Duration) ([]store.Task, error) {
	return f.stalled, f.stalledErr
}

func (f *fakeRepo) Transition(_ context.Context, _ string, ev contract.TaskEvent, _ *string) (store.TransitionResult, error) {
	f.trans = append(f.trans, ev)
	return store.TransitionResult{Changed: true}, nil
}

func (f *fakeRepo) UpdateFileMetadata(_ context.Context, _ string, name string, size int64) error {
	f.fileName, f.fileSize = name, size
	return nil
}

func (f *fakeRepo) UpdateSourceRef(_ context.Context, _ string, ref string) error {
	f.srcRef = ref
	return nil
}

// fakeRclone 代替真实的 rclone 子进程。
type fakeRclone struct {
	mkdirErr    error
	uploadErr   error
	mkdirCalls  []string
	uploadCalls []string
}

func (f *fakeRclone) Mkdir(_ context.Context, _ rclone.Config, remotePath string) error {
	f.mkdirCalls = append(f.mkdirCalls, remotePath)
	return f.mkdirErr
}

func (f *fakeRclone) Upload(_ context.Context, _ rclone.Config, localPath, remotePath string, _ rclone.ProgressFunc) error {
	f.uploadCalls = append(f.uploadCalls, remotePath)
	return f.uploadErr
}

// fakeDrives 代替网盘仓储。
type fakeDrives struct {
	drive *drive.Drive
	err   error
}

func (f *fakeDrives) DefaultDrive(context.Context, string) (*drive.Drive, error) {
	return f.drive, f.err
}
func (f *fakeDrives) DriveByID(context.Context, string) (*drive.Drive, error) {
	return f.drive, f.err
}

func quietApp() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// newTestApp 造一个只够测 download/upload 的 App。
func newTestApp(t *testing.T, dl *fakeDL, repo *fakeRepo, drives *fakeDrives) (*App, string) {
	t.Helper()
	dir := t.TempDir()
	a := &App{
		downloader: dl,
		repo:       repo,
		drives:     drives,
		rclone:     &fakeRclone{},
		// locks 必须给:upload 会走 locks.WithSession,nil 会 panic。
		locks: drive.NewSessionLock(),
		cfg:   Config{DownloadDir: dir, RemoteBase: "/global"},
		log:   quietApp(),
	}
	return a, dir
}

// ---------------------------------------------------------------------------
// download()
// ---------------------------------------------------------------------------

// TestDownloadStoresRealFileSize 是 PR#458 的回归测试。
//
// 关键:存进库的 size 必须来自文件系统,不是 Telegram 的估算值。
// 拿估算值当 --size 判据会让 rclone 报 "sizes differ",任务被
// retryable:false 一次判死 —— 那次真实故障是 7 天 132 次用户失败。
func TestDownloadStoresRealFileSize(t *testing.T) {
	content := "1234567890" // 10 字节
	dl := &fakeDL{content: content}
	repo := &fakeRepo{}
	a, _ := newTestApp(t, dl, repo, &fakeDrives{})

	err := a.download(context.Background(), store.Task{
		ID:        "t1",
		SourceRef: sqlStr("555/42"),
		FileName:  sqlStr("photo.jpg"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if repo.fileSize != int64(len(content)) {
		t.Errorf("存的 size = %d,期望 %d(必须来自文件系统,不是 Telegram 估算)",
			repo.fileSize, len(content))
	}
	if repo.fileName != "photo.jpg" {
		t.Errorf("存的文件名 = %q", repo.fileName)
	}
}

// TestDownloadRejectsMissingSourceRef 没有源引用必须明确失败。
func TestDownloadRejectsMissingSourceRef(t *testing.T) {
	dl := &fakeDL{}
	repo := &fakeRepo{}
	a, _ := newTestApp(t, dl, repo, &fakeDrives{})

	for _, ref := range []store.Task{
		{ID: "t1", SourceRef: sqlStr("")},
		{ID: "t1"}, // 未设置
	} {
		if err := a.download(context.Background(), ref); err == nil {
			t.Errorf("sourceRef=%q 应报错", ref.SourceRef.String)
		}
	}
	if dl.calls != 0 {
		t.Error("参数无效时不该发起下载")
	}
}

// TestDownloadRejectsMalformedSourceRef 格式错误必须拒绝,不能瞎解析。
func TestDownloadRejectsMalformedSourceRef(t *testing.T) {
	dl := &fakeDL{}
	a, _ := newTestApp(t, dl, &fakeRepo{}, &fakeDrives{})

	if err := a.download(context.Background(), store.Task{
		ID: "t1", SourceRef: sqlStr("not-a-path"),
	}); err == nil {
		t.Error("畸形 sourceRef 应报错")
	}
	if dl.calls != 0 {
		t.Error("参数无效时不该发起下载")
	}
}

// TestDownloadPropagatesFailure 下载失败必须往上抛 ——
// task.Manager 靠这个把任务标 failed。
func TestDownloadPropagatesFailure(t *testing.T) {
	dl := &fakeDL{err: errors.New("network down")}
	a, _ := newTestApp(t, dl, &fakeRepo{}, &fakeDrives{})

	err := a.download(context.Background(), store.Task{
		ID: "t1", SourceRef: sqlStr("555/42"), FileName: sqlStr("a.jpg"),
	})
	if err == nil {
		t.Fatal("下载失败必须返回错误")
	}
	if !strings.Contains(err.Error(), "network down") {
		t.Errorf("错误信息应保留原因,得到 %q", err.Error())
	}
}

// TestDownloadSanitizesFileName 下载路径必须过 sanitize ——
// 文件名来自 Telegram,是完全不受控的输入。
func TestDownloadSanitizesFileName(t *testing.T) {
	dl := &fakeDL{content: "x"}
	a, dir := newTestApp(t, dl, &fakeRepo{}, &fakeDrives{})

	// 目录穿越必须在 sanitize 之后落到下载目录内
	if err := a.download(context.Background(), store.Task{
		ID: "t1", SourceRef: sqlStr("555/42"), FileName: sqlStr("../../etc/passwd"),
	}); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(dl.dest, "..") {
		t.Errorf("目标路径含 ..: %q", dl.dest)
	}
	if !strings.HasPrefix(dl.dest, dir) {
		t.Errorf("目标路径逃出了下载目录 %q:%q", dir, dl.dest)
	}
}

// TestDownloadParsesChatAndMsgID sourceRef 的 "chat/msg" 必须正确拆开 ——
// 拆错了会下载错的消息(用户传的是 A 文件,拿到的是 B)。
func TestDownloadParsesChatAndMsgID(t *testing.T) {
	dl := &fakeDL{content: "x"}
	a, _ := newTestApp(t, dl, &fakeRepo{}, &fakeDrives{})

	if err := a.download(context.Background(), store.Task{
		ID: "t1", SourceRef: sqlStr("-1001234567890/987"), FileName: sqlStr("a.txt"),
	}); err != nil {
		t.Fatal(err)
	}
	if dl.chatID != -1001234567890 {
		t.Errorf("chatID = %d,期望 -1001234567890(负数是群组 id)", dl.chatID)
	}
	if dl.msgID != 987 {
		t.Errorf("msgID = %d,期望 987", dl.msgID)
	}
}

// ---------------------------------------------------------------------------
// upload()
// ---------------------------------------------------------------------------

// TestUploadFailsWhenNoDrive 用户没绑网盘必须明确报错。
//
// 这是一条用户可见的错误路径,零测试意味着它可能一直坏着。
func TestUploadFailsWhenNoDrive(t *testing.T) {
	repo := &fakeRepo{}
	a, _ := newTestApp(t, &fakeDL{}, repo, &fakeDrives{drive: nil})

	err := a.upload(context.Background(), store.Task{
		ID: "t1", UserID: "u1", FileName: sqlStr("a.txt"),
	})
	if err == nil {
		t.Fatal("用户没绑网盘时上传必须失败")
	}
	if !strings.Contains(err.Error(), "没有绑定网盘") {
		t.Errorf("错误信息应说清是「没绑网盘」,得到 %q", err.Error())
	}
}

// TestUploadRejectsPlaceholderDrive 9 个未实现的网盘要明确拒绝。
func TestUploadRejectsPlaceholderDrive(t *testing.T) {
	a, _ := newTestApp(t, &fakeDL{}, &fakeRepo{}, &fakeDrives{
		drive: &drive.Drive{Type: "gdrive"},
	})

	err := a.upload(context.Background(), store.Task{
		ID: "t1", UserID: "u1", FileName: sqlStr("a.txt"),
	})
	if err == nil {
		t.Fatal("占位网盘必须拒绝")
	}
	if !strings.Contains(err.Error(), "尚未实现") {
		t.Errorf("错误信息应说明是占位,得到 %q", err.Error())
	}
}

// TestUploadGoesThroughSessionLock 确认 upload 真的走了 SessionLock。
//
// 这是最危险的一条:把 a.locks.WithSession(...) 改成直接调用
// rclone.Upload,所有测试依然全绿,而 Proton 的一次性 refresh_token
// 竞态立刻回来 → Code=10013 → 账号永久砖化(记忆里的教训)。
func TestUploadGoesThroughSessionLock(t *testing.T) {
	locks := drive.NewSessionLock()
	a, _ := newTestApp(t, &fakeDL{}, &fakeRepo{}, &fakeDrives{
		drive: &drive.Drive{
			Type: "protondrive",
			Config: drive.DriveConfig{
				Username:  "u@p.me",
				ClientUID: "uid", ClientAccessToken: "a",
				ClientRefreshToken: "r", ClientSaltedKeyPass: "s",
			},
		},
	})
	a.locks = locks

	// 先拿锁,再调 upload —— 如果 upload 不走 WithSession,
	// 它会在锁被持有时照样执行,证明没有串行化。
	if unlock := locks.Lock(drive.Key("protondrive", "u1")); true {
		done := make(chan struct{})
		go func() {
			_ = a.upload(context.Background(), store.Task{
				ID: "t1", UserID: "u1", FileName: sqlStr("a.txt"),
			})
			close(done)
		}()
		select {
		case <-done:
			unlock()
			t.Fatal("upload 绕过了 SessionLock —— Proton 竞态会回来")
		case <-time.After(200 * time.Millisecond):
			// 正确:upload 在等锁
			unlock()
			<-done
		}
	}
}

// TestUploadUsesUserRemoteFolder 用户在 UI 设的目录要优先于全局默认。
//
// 反了的话文件传到根目录 —— 用户看不见,而任务显示「成功」。
func TestUploadUsesUserRemoteFolder(t *testing.T) {
	repo := &fakeRepo{}
	a, _ := newTestApp(t, &fakeDL{}, repo, &fakeDrives{
		drive: &drive.Drive{
			Type:   "mega",
			Config: drive.DriveConfig{User: "u@x.com", Pass: "p"},
		},
	})

	if err := a.upload(context.Background(), store.Task{
		ID: "t1", UserID: "u1", FileName: sqlStr("a.txt"),
	}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(repo.srcRef, "/global/") {
		t.Errorf("远端路径 = %q,应以全局目录为底", repo.srcRef)
	}
}

// TestUploadRecordsRemotePath 上传成功后要记下远端路径 ——
// 出问题时能告诉用户文件本该去哪。
func TestUploadRecordsRemotePath(t *testing.T) {
	repo := &fakeRepo{}
	a, _ := newTestApp(t, &fakeDL{}, repo, &fakeDrives{
		drive: &drive.Drive{
			Type: "mega", Config: drive.DriveConfig{User: "u@x.com", Pass: "p"},
		},
	})

	if err := a.upload(context.Background(), store.Task{
		ID: "t1", UserID: "u1", FileName: sqlStr("photo.jpg"),
	}); err != nil {
		t.Fatal(err)
	}
	if repo.srcRef == "" {
		t.Error("上传后没记下远端路径 —— 出错时无法定位文件")
	}
	if !strings.HasSuffix(repo.srcRef, "photo.jpg") {
		t.Errorf("远端路径应含文件名,得到 %q", repo.srcRef)
	}
}

// TestUploadPropagatesRcloneFailure rclone 失败必须往上抛。
func TestUploadPropagatesRcloneFailure(t *testing.T) {
	a, _ := newTestApp(t, &fakeDL{}, &fakeRepo{}, &fakeDrives{
		drive: &drive.Drive{
			Type: "mega", Config: drive.DriveConfig{User: "u@x.com", Pass: "p"},
		},
	})
	a.rclone = &fakeRclone{uploadErr: errors.New("rclone exit 1")}

	err := a.upload(context.Background(), store.Task{
		ID: "t1", UserID: "u1", FileName: sqlStr("a.txt"),
	})
	if err == nil {
		t.Fatal("rclone 失败必须返回错误")
	}
	if !strings.Contains(err.Error(), "上传失败") {
		t.Errorf("错误信息应说明是上传失败,得到 %q", err.Error())
	}
}

// helper

func sqlStr(s string) sql.NullString { return sql.NullString{String: s, Valid: true} }
