package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
)

func TestHandleSocialMediaMessage_NotSocial(t *testing.T) {
	app := &App{}
	msg := messageInfo{
		Text: "Hello there, this is a plain message with no links.",
	}
	if app.handleSocialMediaMessage(context.Background(), msg) {
		t.Fatalf("plain message should not be handled by handleSocialMediaMessage")
	}
}

func TestHandleSocialMediaMessage_UnboundDrive(t *testing.T) {
	repo := &fakeRepo{}
	notices := &linkMockNotices{}
	app := newTestLinkApp(repo, &fakeDrives{}, nil, notices)

	msg := messageInfo{
		ID:       100,
		ChatID:   42,
		SenderID: 1001,
		Text:     "Check this: https://x.com/jack/status/20",
	}

	consumed := app.handleSocialMediaMessage(context.Background(), msg)
	if !consumed {
		t.Fatalf("unbound drive social message should be consumed (prompted user)")
	}
	if len(notices.messages) == 0 {
		t.Fatalf("expected drive prompt message, got none")
	}
}

func TestDownloadExternal_HTTP(t *testing.T) {
	testContent := "hello social video content"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "26")
		w.Write([]byte(testContent))
	}))
	defer srv.Close()

	tmpDir := t.TempDir()
	repo := &fakeRepo{}
	notices := &linkMockNotices{}
	app := newTestLinkApp(repo, boundDrive(), nil, notices)
	app.cfg = Config{DownloadDir: tmpDir}

	taskID := "task-social-test"
	ref := externalSourceRef{
		URL:      srv.URL + "/video.mp4",
		Quality:  "1080p",
		Platform: "twitter",
	}
	refBytes, _ := json.Marshal(ref)

	tObj := store.Task{
		ID:         taskID,
		UserID:     "1001",
		SourceType: "external_url",
		FileName:   sql.NullString{String: "tweet_video.mp4", Valid: true},
		FileSize:   26,
		SourceRef:  sql.NullString{String: string(refBytes), Valid: true},
		Status:     contract.StatusDownloading,
	}

	if err := app.downloadExternal(context.Background(), tObj); err != nil {
		t.Fatalf("downloadExternal failed: %v", err)
	}

	dest := filepath.Join(tmpDir, "tweet_video.mp4")
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("failed to read downloaded file: %v", err)
	}
	if string(data) != testContent {
		t.Fatalf("downloaded content mismatch: got %q, want %q", string(data), testContent)
	}

	if repo.fileSize != int64(len(testContent)) {
		t.Fatalf("expected FileSize %d, got %d", len(testContent), repo.fileSize)
	}
}
