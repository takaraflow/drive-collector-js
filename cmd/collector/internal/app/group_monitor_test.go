package app

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
)

func TestShortenFileName(t *testing.T) {
	cases := []struct {
		input  string
		maxLen int
		want   string
	}{
		{"abc.mp4", 10, "abc.mp4"},
		{"abcdefghij.mp4", 14, "abcdefghij.mp4"},
		{"very_long_file_name_that_exceeds_limits.mp4", 20, "very_long…limits.mp4"},
		{"short", 10, "short"},
	}

	for _, c := range cases {
		got := shortenFileName(c.input, c.maxLen)
		if got != c.want {
			t.Errorf("shortenFileName(%q, %d) = %q, want %q", c.input, c.maxLen, got, c.want)
		}
	}
}

func TestRenderGroupMonitor_Queued(t *testing.T) {
	tasks := []store.Task{
		{
			ID:        "t1",
			FileName:  sql.NullString{String: "photo1.jpg", Valid: true},
			Status:    contract.StatusQueued,
			GroupedID: sql.NullInt64{Int64: 888999, Valid: true},
		},
		{
			ID:        "t2",
			FileName:  sql.NullString{String: "photo2.jpg", Valid: true},
			Status:    contract.StatusQueued,
			GroupedID: sql.NullInt64{Int64: 888999, Valid: true},
		},
	}

	text, buttons := renderGroupMonitor(tasks, nil, "", "/photos", nil)
	if !strings.Contains(text, "媒体组转存看板 (0/2)") {
		t.Errorf("标题期望包含 0/2，实际文本:\n%s", text)
	}
	if !strings.Contains(text, "photo1.jpg") || !strings.Contains(text, "photo2.jpg") {
		t.Errorf("文件列表缺失文件名，实际文本:\n%s", text)
	}
	if !strings.Contains(text, "🕒") {
		t.Errorf("排队图标缺失，实际文本:\n%s", text)
	}
	if !hasButton(buttons, "cancel_group_confirm_888999") {
		t.Errorf("未完成时应带取消整组按钮: %+v", buttons)
	}
}

func TestRenderGroupMonitor_AllCompleted(t *testing.T) {
	tasks := []store.Task{
		{
			ID:        "t1",
			FileName:  sql.NullString{String: "photo1.jpg", Valid: true},
			Status:    contract.StatusCompleted,
			GroupedID: sql.NullInt64{Int64: 888999, Valid: true},
		},
		{
			ID:        "t2",
			FileName:  sql.NullString{String: "photo2.jpg", Valid: true},
			Status:    contract.StatusCompleted,
			GroupedID: sql.NullInt64{Int64: 888999, Valid: true},
		},
	}

	text, buttons := renderGroupMonitor(tasks, nil, "", "/photos", nil)
	if !strings.Contains(text, "媒体组转存完成 (2/2)") {
		t.Errorf("标题期望全部完成，实际文本:\n%s", text)
	}
	if !strings.Contains(text, "📁 目录") || !strings.Contains(text, "/photos") {
		t.Errorf("完成时应显示目标目录，实际文本:\n%s", text)
	}
	if buttons != nil {
		t.Errorf("全部完成时不应保留取消按钮: %+v", buttons)
	}
}

func TestRenderGroupMonitor_FocusStatusOverride(t *testing.T) {
	tasks := []store.Task{
		{
			ID:        "t1",
			FileName:  sql.NullString{String: "video1.mp4", Valid: true},
			Status:    contract.StatusQueued,
			GroupedID: sql.NullInt64{Int64: 888999, Valid: true},
		},
	}

	text, _ := renderGroupMonitor(tasks, &tasks[0], string(contract.StatusDownloading), "/videos", nil)
	if !strings.Contains(text, "🔄") || !strings.Contains(text, "(下载中)") {
		t.Errorf("focusStatus 应优先覆盖当前任务显示，实际文本:\n%s", text)
	}
}

func TestRefreshGroupMonitor_UpdatesNotice(t *testing.T) {
	repo := &fakeRepo{
		batch: []store.Task{
			{
				ID:        "t1",
				ChatID:    nullableString("12345"),
				UserID:    "42",
				FileName:  sql.NullString{String: "img.jpg", Valid: true},
				Status:    contract.StatusDownloading,
				GroupedID: sql.NullInt64{Int64: 777, Valid: true},
				MsgID:     nullableInt(9001),
			},
		},
	}
	nf := &fakeNotices{}
	app := &App{
		repo:     repo,
		notices:  nf,
		notifier: nf,
		drives:   boundDrive(),
		log:      quietApp(),
	}

	task := &repo.batch[0]
	app.refreshGroupMonitor(context.Background(), task, string(contract.StatusDownloading), nil)

	if len(nf.edits) != 1 {
		t.Fatalf("refreshGroupMonitor 应编辑 1 条消息，实际: %d", len(nf.edits))
	}
	if !strings.Contains(nf.edits[0], "媒体组转存看板") || !strings.Contains(nf.edits[0], "img.jpg") {
		t.Errorf("更新内容不符合预期:\n%s", nf.edits[0])
	}
}
