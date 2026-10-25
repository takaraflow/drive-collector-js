package app

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	"github.com/youngsx/drive-collector/cmd/collector/internal/task"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// streamingFakeDL 模拟流式下载行为（支持正常写流与模拟卡死/报错）。
type streamingFakeDL struct {
	fakeDL
	streamErr     error
	streamCalls   int
	downloadCalls int
}

func (s *streamingFakeDL) DownloadStream(_ context.Context, _ int64, _ int64, w io.Writer, _ tgclient.ProgressFunc) error {
	s.streamCalls++
	if s.streamErr != nil {
		return s.streamErr
	}
	_, err := w.Write([]byte("streaming-data-payload"))
	return err
}

func (s *streamingFakeDL) DownloadTo(ctx context.Context, chatID, msgID int64, dest string, progress tgclient.ProgressFunc) error {
	s.downloadCalls++
	return s.fakeDL.DownloadTo(ctx, chatID, msgID, dest, progress)
}

func TestStreamTransfer_DirectSuccess(t *testing.T) {
	ctx := context.Background()

	dl := &streamingFakeDL{
		fakeDL: fakeDL{content: "payload"},
	}
	rc := &fakeRclone{}
	repo := &fakeRepo{}
	drives := &fakeDrives{
		drive: &drive.Drive{
			ID:        "drv1",
			UserID:    "user1",
			Type:      "mega",
			Config:    drive.DriveConfig{User: "u", Pass: "p"},
			IsDefault: 1,
		},
	}

	taskID := "task-stream-ok"
	tsk := store.Task{
		ID:        taskID,
		UserID:    "user1",
		Status:    contract.StatusQueued,
		FileName:  sql.NullString{String: "stream_video.mp4", Valid: true},
		FileSize:  1024,
		SourceRef: sql.NullString{String: "100/1000", Valid: true},
	}
	repo.byID = &tsk

	a := &App{
		downloader: dl,
		rclone:     rc,
		repo:       repo,
		drives:     drives,
		locks:      drive.NewSessionLock(),
		log:        quietApp(),
		tasks:      task.NewManager(repo, quietApp()),
		cfg: Config{
			EnableStreamPipe: true,
			RemoteBase:       "backups",
		},
	}
	a.tasks.Download = a.download
	a.tasks.Upload = a.upload

	// 触发处理
	a.processTask(ctx, taskID)

	if dl.streamCalls != 1 {
		t.Errorf("expected 1 stream call, got %d", dl.streamCalls)
	}
	if dl.downloadCalls != 0 {
		t.Errorf("expected 0 disk download calls on success, got %d", dl.downloadCalls)
	}
	if len(rc.uploadCalls) != 1 {
		t.Fatalf("expected 1 rclone rcat call, got %d", len(rc.uploadCalls))
	}
	if rc.uploadCalls[0] != "backups/stream_video.mp4" {
		t.Errorf("unexpected target path: %q", rc.uploadCalls[0])
	}

	// 状态机事件应已完成完整直传流转
	evs := repo.eventsByID(taskID)
	expected := []contract.TaskEvent{
		contract.EventStartDownload,
		contract.EventFinishDownload,
		contract.EventStartUpload,
		contract.EventComplete,
	}
	if len(evs) != len(expected) {
		t.Fatalf("unexpected events count: got %v, expected %v", evs, expected)
	}
	for i, exp := range expected {
		if evs[i] != exp {
			t.Errorf("event [%d]: got %v, expected %v", i, evs[i], exp)
		}
	}
}

func TestStreamTransfer_FallbackToDiskOnStreamError(t *testing.T) {
	ctx := context.Background()

	dl := &streamingFakeDL{
		fakeDL:    fakeDL{content: "fallback-content"},
		streamErr: errors.New("upstream telegram stream interrupted"),
	}
	rc := &fakeRclone{}
	repo := &fakeRepo{}
	drives := &fakeDrives{
		drive: &drive.Drive{
			ID:        "drv1",
			UserID:    "user1",
			Type:      "mega",
			Config:    drive.DriveConfig{User: "u", Pass: "p"},
			IsDefault: 1,
		},
	}

	taskID := "task-fallback"
	tsk := store.Task{
		ID:        taskID,
		UserID:    "user1",
		Status:    contract.StatusQueued,
		FileName:  sql.NullString{String: "fallback.mp4", Valid: true},
		FileSize:  2048,
		SourceRef: sql.NullString{String: "100/2000", Valid: true},
	}
	repo.byID = &tsk

	a := &App{
		downloader: dl,
		rclone:     rc,
		repo:       repo,
		drives:     drives,
		locks:      drive.NewSessionLock(),
		log:        quietApp(),
		tasks:      task.NewManager(repo, quietApp()),
		cfg: Config{
			EnableStreamPipe: true,
			DownloadDir:      t.TempDir(),
			RemoteBase:       "backups",
		},
	}
	a.tasks.Download = a.download
	a.tasks.Upload = a.upload

	// 触发处理
	a.processTask(ctx, taskID)

	// 验证：直传失败后平滑降级到 DownloadTo 并在本地落盘后上传
	if dl.streamCalls != 1 {
		t.Errorf("expected 1 stream attempt, got %d", dl.streamCalls)
	}
	if dl.downloadCalls != 1 {
		t.Errorf("expected 1 disk download fallback call, got %d", dl.downloadCalls)
	}

	// 验证降级流转事件：EventStartDownload -> EventResetStalled -> EventStartDownload -> EventFinishDownload -> EventStartUpload -> EventComplete
	evs := repo.eventsByID(taskID)
	expected := []contract.TaskEvent{
		contract.EventStartDownload,
		contract.EventResetStalled,
		contract.EventStartDownload,
		contract.EventFinishDownload,
		contract.EventStartUpload,
		contract.EventComplete,
	}
	if len(evs) != len(expected) {
		t.Fatalf("unexpected events count on fallback: got %v, expected %v", evs, expected)
	}
	for i, exp := range expected {
		if evs[i] != exp {
			t.Errorf("event [%d]: got %v, expected %v", i, evs[i], exp)
		}
	}
}
