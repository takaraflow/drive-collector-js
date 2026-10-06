package app

// /files 的最小可跑检查。命令入口要真连 Telegram,测不到;能测的
// 是纯渲染和「列的是哪个目录、排序对不对、没绑盘给什么」。

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
)

func newFilesApp(rc *fakeRclone, drives *fakeDrives) *App {
	return &App{
		rclone:  rc,
		drives:  drives,
		locks:   drive.NewSessionLock(),
		pending: make(chan string, pendingQueueSize),
		cfg:     Config{RemoteBase: "/global"},
		log:     quietApp(),
	}
}

func megaDrive() *drive.Drive {
	return &drive.Drive{
		ID:     "d1",
		UserID: "42",
		Type:   string(drive.TypeMega),
		Config: drive.DriveConfig{User: "u@example.com", Pass: "p"},
		RemoteFolder: sql.NullString{
			String: "/myfolder", Valid: true,
		},
	}
}

// TestFilesViewListsUserFolder —— 列的必须是用户设置的目录,不是全局默认。
func TestFilesViewListsUserFolder(t *testing.T) {
	rc := &fakeRclone{list: []rclone.FileEntry{
		{Name: "old.txt", Size: 1, ModTime: "2026-01-01T00:00:00Z"},
		{Name: "new.mp4", Size: 2, ModTime: "2026-10-01T00:00:00Z"},
	}}
	a := newFilesApp(rc, &fakeDrives{drive: megaDrive()})

	text, buttons, err := a.filesView(context.Background(), "42", 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rc.listCalls) != 1 || rc.listCalls[0] != "/myfolder" {
		t.Errorf("ListFiles 路径 = %v,期望 [/myfolder]", rc.listCalls)
	}
	// 文件按修改时间倒序:新的排前面。
	if !strings.Contains(text, "🎞️ <b>new.mp4</b>") {
		t.Errorf("清单缺 new.mp4:\n%s", text)
	}
	if !strings.Contains(text, "目录</b>: <code>/myfolder</code>") {
		t.Errorf("头部目录不对:\n%s", text)
	}
	if !strings.Contains(text, "第 1/1 页 | 共 2 个文件") {
		t.Errorf("页脚不对:\n%s", text)
	}
	if len(buttons) == 0 || len(buttons[0]) == 0 {
		t.Error("没有翻页按钮")
	}
}

// TestFilesViewSortsDirsFirst —— 目录永远排在文件前面(与 JS 一致)。
func TestFilesViewSortsDirsFirst(t *testing.T) {
	rc := &fakeRclone{list: []rclone.FileEntry{
		{Name: "z-newest.txt", ModTime: "2026-10-01T00:00:00Z"},
		{Name: "a-dir", IsDir: true, ModTime: "2020-01-01T00:00:00Z"},
	}}
	a := newFilesApp(rc, &fakeDrives{drive: megaDrive()})

	text, _, err := a.filesView(context.Background(), "42", 0)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Index(text, "a-dir") > strings.Index(text, "z-newest.txt") {
		t.Errorf("目录没排前面:\n%s", text)
	}
}

// TestFilesViewClampsPage —— 翻过头要夹回最后一页,而不是切数组越界。
func TestFilesViewClampsPage(t *testing.T) {
	list := make([]rclone.FileEntry, filesPageSize+1) // 7 个 → 2 页
	for i := range list {
		list[i].Name = "f"
	}
	rc := &fakeRclone{list: list}
	a := newFilesApp(rc, &fakeDrives{drive: megaDrive()})

	text, _, err := a.filesView(context.Background(), "42", 99)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(text, "第 2/2 页") {
		t.Errorf("页码没被夹回第 2 页:\n%s", text)
	}
}

// TestFilesViewNoDrive —— 没绑盘给绑盘提示,而不是报错。
func TestFilesViewNoDrive(t *testing.T) {
	a := newFilesApp(&fakeRclone{}, &fakeDrives{})

	text, buttons, err := a.filesView(context.Background(), "42", 0)
	if err != nil {
		t.Fatal(err)
	}
	if text != noDriveHint {
		t.Errorf("没绑盘的文案 = %q", text)
	}
	if buttons != nil {
		t.Errorf("没绑盘不该有按钮:%v", buttons)
	}
}

// TestFilesViewLoadError —— rclone 失败要向上抛,由入口换成 load_failed。
func TestFilesViewLoadError(t *testing.T) {
	rc := &fakeRclone{listErr: context.DeadlineExceeded}
	a := newFilesApp(rc, &fakeDrives{drive: megaDrive()})

	if _, _, err := a.filesView(context.Background(), "42", 0); err == nil {
		t.Error("rclone 失败应该报错")
	}
}

// TestRenderFilesPageEscapesName —— 文件名里的 < > & 不能把 HTML 搞坏。
func TestRenderFilesPageEscapesName(t *testing.T) {
	text, _ := renderFilesPage("/f", []rclone.FileEntry{
		{Name: "a<b>&c.mp4", Size: 3, ModTime: "2026-01-02T03:04:05Z"},
	}, 0)
	if !strings.Contains(text, "a&lt;b&gt;&amp;c.mp4") {
		t.Errorf("文件名没转义:\n%s", text)
	}
	if strings.Contains(text, "<b>&c") {
		t.Errorf("原文的尖括号漏进了 HTML:\n%s", text)
	}
}
