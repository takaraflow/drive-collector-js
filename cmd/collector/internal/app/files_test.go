package app

// /files 的最小可跑检查。命令入口要真连 Telegram,测不到;能测的
// 是纯渲染和「列的是哪个目录、排序对不对、没绑盘给什么」。

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

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

	text, buttons, err := a.filesView(context.Background(), "42", 0, false)
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

	text, _, err := a.filesView(context.Background(), "42", 0, false)
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

	text, _, err := a.filesView(context.Background(), "42", 99, false)
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

	text, buttons, err := a.filesView(context.Background(), "42", 0, false)
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

	if _, _, err := a.filesView(context.Background(), "42", 0, false); err == nil {
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

// TestFilesCacheAvoidsRelist 翻页连击不该每次都真跑 lsjson ——
// 内存缓存挡住;刷新(force)必须绕过缓存。
func TestFilesCacheAvoidsRelist(t *testing.T) {
	rc := &fakeRclone{list: []rclone.FileEntry{
		{Name: "a.txt", ModTime: "2026-01-01T00:00:00Z"},
	}}
	a := newFilesApp(rc, &fakeDrives{drive: megaDrive()})

	for i := 0; i < 3; i++ {
		if _, _, err := a.filesView(context.Background(), "42", i, false); err != nil {
			t.Fatal(err)
		}
	}
	if len(rc.listCalls) != 1 {
		t.Errorf("翻页连击后 lsjson 跑了 %d 次,期望 1(缓存命中)", len(rc.listCalls))
	}

	if _, _, err := a.filesView(context.Background(), "42", 0, true); err != nil {
		t.Fatal(err)
	}
	if len(rc.listCalls) != 2 {
		t.Errorf("刷新后 lsjson 跑了 %d 次,期望 2(force 绕过缓存)", len(rc.listCalls))
	}
}

// TestFilesRefreshGate 10 秒内第二次刷新必须被限流,且被限流不更新时间戳。
func TestFilesRefreshGate(t *testing.T) {
	a := newFilesApp(&fakeRclone{}, &fakeDrives{})

	if _, gated := a.filesRefreshGated(42, 100); gated {
		t.Error("第一次刷新不该被限流")
	}
	wait, gated := a.filesRefreshGated(42, 100)
	if !gated || wait <= 0 || wait > 10 {
		t.Errorf("第二次刷新应被限流且等待秒数在 (0,10],得到 gated=%v wait=%d", gated, wait)
	}
	// 换一条消息不受影响 —— 冷却按 (用户,消息) 计。
	if _, gated := a.filesRefreshGated(42, 101); gated {
		t.Error("另一条消息的刷新不该被限流")
	}
}

// TestOptimalFilesTTL 各档位与 JS _calculateOptimalCacheTime 一致。
func TestOptimalFilesTTL(t *testing.T) {
	if got := optimalFilesTTL(nil); got != 5*time.Minute {
		t.Errorf("空目录应缓存 5 分钟,得到 %v", got)
	}
	// 只有一个 7 天内的文件 → 文件太少,15 分钟。
	few := []rclone.FileEntry{{Name: "a", ModTime: time.Now().Add(-time.Hour).Format(time.RFC3339)}}
	if got := optimalFilesTTL(few); got != 15*time.Minute {
		t.Errorf("文件少应缓存 15 分钟,得到 %v", got)
	}
	// 平均间隔 ~30 秒(高频)→ 2 分钟。
	now := time.Now()
	hot := []rclone.FileEntry{}
	for i := 0; i < 5; i++ {
		hot = append(hot, rclone.FileEntry{
			Name:    fmt.Sprintf("f%d", i),
			ModTime: now.Add(-time.Duration(i*30) * time.Second).Format(time.RFC3339),
		})
	}
	if got := optimalFilesTTL(hot); got != 2*time.Minute {
		t.Errorf("高频变化应缓存 2 分钟,得到 %v", got)
	}
	// 平均间隔 ~12 小时(低频)→ 30 分钟。恰好 24 小时会掉进下一档。
	cold := []rclone.FileEntry{}
	for i := 0; i < 5; i++ {
		cold = append(cold, rclone.FileEntry{
			Name:    fmt.Sprintf("f%d", i),
			ModTime: now.Add(-time.Duration(i*12) * time.Hour).Format(time.RFC3339),
		})
	}
	if got := optimalFilesTTL(cold); got != 30*time.Minute {
		t.Errorf("低频变化应缓存 30 分钟,得到 %v", got)
	}
}

// TestFetchRemoteFilesCreatesMissingDir 目录不存在要先建再试 —— 与 JS
// listRemoteFiles 一致;建完还看不到就当空目录,不给用户报错。
func TestFetchRemoteFilesCreatesMissingDir(t *testing.T) {
	rc := &fakeRclone{listErr: rclone.ErrDirNotFound}
	a := newFilesApp(rc, &fakeDrives{drive: megaDrive()})

	files, err := a.fetchRemoteFiles(context.Background(), &drive.Drive{
		ID: "d1", UserID: "42", Type: string(drive.TypeMega),
		Config:       drive.DriveConfig{User: "u", Pass: "p"},
		RemoteFolder: sql.NullString{String: "/myfolder", Valid: true},
	})
	if err != nil {
		t.Fatalf("目录不存在不该报错: %v", err)
	}
	if len(files) != 0 {
		t.Errorf("应为空清单,得到 %+v", files)
	}
	if len(rc.mkdirCalls) != 1 || rc.mkdirCalls[0] != "/myfolder" {
		t.Errorf("应补建目录 /myfolder 一次,mkdir = %v", rc.mkdirCalls)
	}
	if len(rc.listCalls) != 2 {
		t.Errorf("应列表两次(原试+建后重试),得到 %d 次", len(rc.listCalls))
	}
}

// TestFilesCacheBlobShape Redis 层的 JSON 形状必须与 JS 侧写的
// {files, timestamp, userId} 一致 —— 切换期两边读写同一个键,
// 少一个字段或改一个名字,JS 就读不懂 Go 写的缓存(或反过来)。
func TestFilesCacheBlobShape(t *testing.T) {
	blob, err := json.Marshal(filesCacheBlob{
		Files:     []rclone.FileEntry{{Name: "a.mp4", Size: 10, ModTime: "2026-10-01T05:06:07Z", IsDir: false}},
		Timestamp: 1760000000000,
		UserID:    "42",
	})
	if err != nil {
		t.Fatal(err)
	}
	var generic map[string]interface{}
	if err := json.Unmarshal(blob, &generic); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"files", "timestamp", "userId"} {
		if _, ok := generic[key]; !ok {
			t.Errorf("缓存缺字段 %q: %s", key, blob)
		}
	}
	// 条目字段名必须与 rclone lsjson 输出同名 —— JS 侧按这些名字读。
	if !strings.Contains(string(blob), `"Name":"a.mp4"`) {
		t.Errorf("条目缺 Name 字段: %s", blob)
	}
	if !strings.Contains(string(blob), `"IsDir":false`) {
		t.Errorf("条目缺 IsDir 字段: %s", blob)
	}
}
