package app

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	"github.com/youngsx/drive-collector/cmd/collector/internal/task"
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

func TestRenderProgressBar(t *testing.T) {
	cases := []struct {
		ratio float64
		want  string
	}{
		{0.0, "<code>[░░░░░░░░░░]</code> 0%"},
		{0.5, "<code>[█████░░░░░]</code> 50%"},
		{1.0, "<code>[██████████]</code> 100%"},
	}
	for _, c := range cases {
		got := renderProgressBar(c.ratio, 10)
		if got != c.want {
			t.Errorf("renderProgressBar(%v, 10) = %q, want %q", c.ratio, got, c.want)
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
	if !strings.Contains(text, "0%") {
		t.Errorf("应包含进度条百分比，实际文本:\n%s", text)
	}
	if !hasButton(buttons, "cancel_group_confirm_888999") {
		t.Errorf("未完成时应带取消整组按钮: %+v", buttons)
	}
}

func TestRenderGroupMonitor_AllCompleted(t *testing.T) {
	now := time.Now()
	tasks := []store.Task{
		{
			ID:        "t1",
			FileName:  sql.NullString{String: "photo1.jpg", Valid: true},
			FileSize:  1024 * 1024,
			Status:    contract.StatusCompleted,
			GroupedID: sql.NullInt64{Int64: 888999, Valid: true},
			CreatedAt: now.Add(-15 * time.Second).UnixMilli(),
			UpdatedAt: now.UnixMilli(),
		},
		{
			ID:        "t2",
			FileName:  sql.NullString{String: "photo2.jpg", Valid: true},
			FileSize:  2 * 1024 * 1024,
			Status:    contract.StatusCompleted,
			GroupedID: sql.NullInt64{Int64: 888999, Valid: true},
			CreatedAt: now.Add(-15 * time.Second).UnixMilli(),
			UpdatedAt: now.UnixMilli(),
		},
	}

	text, buttons := renderGroupMonitor(tasks, nil, "", "/photos", nil)
	if !strings.Contains(text, "媒体组转存完成 (2/2)") {
		t.Errorf("标题期望全部完成，实际文本:\n%s", text)
	}
	if !strings.Contains(text, "100%") {
		t.Errorf("完成时进度条应为 100%%，实际文本:\n%s", text)
	}
	if !strings.Contains(text, "📦 总大小: <code>3.0 MB</code>") {
		t.Errorf("应渲染总体积统计，实际文本:\n%s", text)
	}
	if !strings.Contains(text, "⏱ 耗时: <code>15s</code>") {
		t.Errorf("应渲染总耗时，实际文本:\n%s", text)
	}
	if !strings.Contains(text, "📁 目录") || !strings.Contains(text, "/photos") {
		t.Errorf("完成时应显示目标目录，实际文本:\n%s", text)
	}
	if buttons != nil {
		t.Errorf("全部完成时无失败项不应保留任何按钮: %+v", buttons)
	}
}

func TestRenderGroupMonitor_LargeGroupFolding(t *testing.T) {
	// 构造 15 个任务的超大组
	tasks := make([]store.Task, 15)
	for i := 0; i < 15; i++ {
		tasks[i] = store.Task{
			ID:        fmt.Sprintf("t%d", i),
			FileName:  sql.NullString{String: fmt.Sprintf("file_%02d.jpg", i), Valid: true},
			GroupedID: sql.NullInt64{Int64: 777666, Valid: true},
		}
		if i < 12 {
			tasks[i].Status = contract.StatusCompleted
		} else {
			tasks[i].Status = contract.StatusDownloading
		}
	}

	// 12 个完成，3 个下载中：已完成项应折叠
	text, _ := renderGroupMonitor(tasks, nil, "", "/photos", nil)
	if !strings.Contains(text, "✅ 已完成 12 个文件 (已折叠)") {
		t.Errorf("大组未完成时已完成项应折叠，实际文本:\n%s", text)
	}
	if !strings.Contains(text, "file_12.jpg") || !strings.Contains(text, "file_14.jpg") {
		t.Errorf("进行中的任务必须展示，实际文本:\n%s", text)
	}

	// 全部 15 个完成：应折叠中间条目
	for i := 12; i < 15; i++ {
		tasks[i].Status = contract.StatusCompleted
	}
	completedText, _ := renderGroupMonitor(tasks, nil, "", "/photos", nil)
	if !strings.Contains(completedText, "折叠其余 10 个已完成文件") {
		t.Errorf("大组全完成时应折叠中间项，实际文本:\n%s", completedText)
	}
}

func TestRenderGroupMonitor_RetryFailedButton(t *testing.T) {
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
			Status:    contract.StatusFailed,
			GroupedID: sql.NullInt64{Int64: 888999, Valid: true},
			ErrorMsg:  sql.NullString{String: "connection reset", Valid: true},
		},
	}

	text, buttons := renderGroupMonitor(tasks, nil, "", "/photos", nil)
	if !strings.Contains(text, "媒体组转存结束 (1/2)") {
		t.Errorf("部分失败标题不对:\n%s", text)
	}
	if !hasButton(buttons, "retry_group_failed_888999") {
		t.Fatalf("有失败项且活跃数为 0 时应挂重试按钮: %+v", buttons)
	}
}

func TestRetryGroupFailed_RequeuesTasks(t *testing.T) {
	repo := &statusRepo{
		fakeRepo: &fakeRepo{
			batch: []store.Task{
				{
					ID:        "t1",
					UserID:    "42",
					ChatID:    nullableString("123"),
					Status:    contract.StatusCompleted,
					GroupedID: sql.NullInt64{Int64: 888999, Valid: true},
					MsgID:     nullableInt(9001),
				},
				{
					ID:        "t2",
					UserID:    "42",
					ChatID:    nullableString("123"),
					Status:    contract.StatusFailed,
					GroupedID: sql.NullInt64{Int64: 888999, Valid: true},
					MsgID:     nullableInt(9001),
				},
			},
		},
	}
	nf := &fakeNotices{}
	app := &App{
		repo:     repo,
		tasks:    task.NewManager(repo, quietApp()),
		notices:  nf,
		notifier: nf,
		drives:   boundDrive(),
		log:      quietApp(),
	}

	resp := app.retryGroupFailed(context.Background(), "42", "888999")
	if !strings.Contains(resp, "已重新排队 1 个失败任务") {
		t.Errorf("重试返回消息不对: %q", resp)
	}
	if len(repo.trans) != 1 || repo.trans[0] != contract.EventRetry {
		t.Errorf("期望打入一次 retry 事件，实际: %v", repo.trans)
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
	// Reset throttle state for test
	gMonitorThrottle.mu.Lock()
	delete(gMonitorThrottle.lastEdit, 777)
	gMonitorThrottle.mu.Unlock()

	app.refreshGroupMonitor(context.Background(), task, string(contract.StatusDownloading), nil)

	if len(nf.edits) != 1 {
		t.Fatalf("refreshGroupMonitor 应编辑 1 条消息，实际: %d", len(nf.edits))
	}
	if !strings.Contains(nf.edits[0], "媒体组转存看板") || !strings.Contains(nf.edits[0], "img.jpg") {
		t.Errorf("更新内容不符合预期:\n%s", nf.edits[0])
	}
}

func TestRefreshGroupMonitor_ThrottlesRapidUpdates(t *testing.T) {
	repo := &fakeRepo{
		batch: []store.Task{
			{
				ID:        "t1",
				ChatID:    nullableString("12345"),
				UserID:    "42",
				FileName:  sql.NullString{String: "img1.jpg", Valid: true},
				Status:    contract.StatusDownloading,
				GroupedID: sql.NullInt64{Int64: 999, Valid: true},
				MsgID:     nullableInt(9002),
			},
			{
				ID:        "t2",
				ChatID:    nullableString("12345"),
				UserID:    "42",
				FileName:  sql.NullString{String: "img2.jpg", Valid: true},
				Status:    contract.StatusQueued,
				GroupedID: sql.NullInt64{Int64: 999, Valid: true},
				MsgID:     nullableInt(9002),
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

	gMonitorThrottle.mu.Lock()
	delete(gMonitorThrottle.lastEdit, 999)
	if timer, ok := gMonitorThrottle.timers[999]; ok {
		timer.Stop()
		delete(gMonitorThrottle.timers, 999)
	}
	gMonitorThrottle.mu.Unlock()

	task1 := &repo.batch[0]
	task2 := &repo.batch[1]

	// 第一次调用立即执行
	app.refreshGroupMonitor(context.Background(), task1, string(contract.StatusDownloading), nil)
	if len(nf.edits) != 1 {
		t.Fatalf("首次调用应立即刷新，实际 edits: %d", len(nf.edits))
	}

	// 瞬态快速第二次调用（< 1s）应被防抖拦截，不立刻触发编辑
	app.refreshGroupMonitor(context.Background(), task2, string(contract.StatusDownloading), nil)
	if len(nf.edits) != 1 {
		t.Errorf("防抖期间不应立即再次编辑，实际 edits: %d", len(nf.edits))
	}

	// 终态调用（如完成或失败）应无视防抖立即刷新
	app.refreshGroupMonitor(context.Background(), task1, string(contract.StatusCompleted), nil)
	if len(nf.edits) != 2 {
		t.Errorf("终态事件必须绕过防抖立即执行，实际 edits: %d", len(nf.edits))
	}
}
