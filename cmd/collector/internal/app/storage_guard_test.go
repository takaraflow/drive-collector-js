package app

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/storageguard"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
)

type fakeStorageGuard struct {
	available uint64
	err       error
	called    bool
}

func (f *fakeStorageGuard) AssertCapacity(dirPath string, expectedBytes int64, purpose string) error {
	f.called = true
	if f.err != nil {
		return f.err
	}
	return nil
}

func (f *fakeStorageGuard) AvailableBytes(dirPath string) (uint64, error) {
	return f.available, nil
}

func TestApp_Download_StorageGuard(t *testing.T) {
	ctx := context.Background()
	dl := &fakeDL{content: "dummy-media-data"}
	repo := &fakeRepo{}
	drives := &fakeDrives{}
	app, _ := newTestApp(t, dl, repo, drives)

	task := store.Task{
		ID:        "tsk-storage-test",
		SourceRef: nullableString(BuildSourceRef(999, 42)),
		FileName:  sql.NullString{String: "test_file.mp4", Valid: true},
		FileSize:  1024 * 1024 * 500, // 500MB
	}

	// 1. 容量不足拦截测试
	mockGuard := &fakeStorageGuard{
		err: &storageguard.InsufficientStorageError{
			DirPath:        app.cfg.DownloadDir,
			ExpectedBytes:  task.FileSize,
			AvailableBytes: 100 * 1024 * 1024,
			RequiredBytes:  800 * 1024 * 1024,
			Purpose:        "task " + task.ID,
		},
	}
	app.storage = mockGuard

	err := app.download(ctx, task)
	if err == nil {
		t.Fatal("expected download to be blocked by storage guard")
	}
	if !strings.Contains(err.Error(), "存储容量检查不通过") {
		t.Fatalf("unexpected error message: %v", err)
	}
	if !mockGuard.called {
		t.Fatal("expected storage guard to be called")
	}
	if dl.calls > 0 {
		t.Fatal("downloader should not have been invoked when storage guard fails")
	}

	// 2. 容量充足放行测试
	mockGuard.called = false
	mockGuard.err = nil
	dl.calls = 0

	err = app.download(ctx, task)
	if err != nil {
		t.Fatalf("expected download to succeed with enough storage, got: %v", err)
	}
	if !mockGuard.called {
		t.Fatal("expected storage guard to be called")
	}
	if dl.calls != 1 {
		t.Fatalf("expected downloader to be invoked once, got %d", dl.calls)
	}
}
