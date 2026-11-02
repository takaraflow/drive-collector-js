package app

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/d1"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

func mockD1WithRows(rows []map[string]any) *d1.Client {
	hc := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			resp := map[string]any{
				"result": []map[string]any{
					{
						"results": rows,
						"success": true,
					},
				},
				"success": true,
				"errors":  []any{},
			}
			body, _ := json.Marshal(resp)
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewReader(body)),
				Header:     make(http.Header),
			}, nil
		}),
	}
	c, _ := d1.New(d1.Config{
		AccountID:  "ui-acc",
		DatabaseID: "ui-db",
		Token:      "ui-tok",
		HTTPClient: hc,
	})
	return c
}

// TestDriveManagerView_ZeroDrives 验证未绑定网盘时直接呈现服务绑定入口，无死按钮。
func TestDriveManagerView_ZeroDrives(t *testing.T) {
	text, buttons := renderDriveManagerView(nil)
	if !strings.Contains(text, "目前尚未绑定任何网盘。请选择下方服务开始绑定：") {
		t.Errorf("文案未包含未绑定提示: %s", text)
	}

	expectedProviders := []string{
		"drive_bind_mega", "drive_bind_protondrive",
		"drive_bind_webdav", "drive_bind_oss",
		"drive_bind_pikpak", "drive_bind_filen",
		"drive_bind_pcloud",
	}

	for _, p := range expectedProviders {
		if !hasButton(buttons, p) {
			t.Errorf("未绑定面板缺失服务入口: %s", p)
		}
	}

	for _, row := range buttons {
		for _, b := range row {
			if b.Data == "noop" || b.Data == "" {
				t.Errorf("发现死按钮或空 Data 按钮: %+v", b)
			}
		}
	}
}

// TestDriveManagerView_WithDrives 验证已绑定网盘时，展示功能按钮与「➕ 绑定其他网盘」菜单入口。
func TestDriveManagerView_WithDrives(t *testing.T) {
	drives := []drive.Drive{
		{
			ID:           "drv-1",
			UserID:       "42",
			Type:         "mega",
			Name:         "mega-alice@example.com",
			IsDefault:    1,
			RemoteFolder: sql.NullString{String: "Photos", Valid: true},
		},
		{
			ID:           "drv-2",
			UserID:       "42",
			Type:         "webdav",
			Name:         "webdav-bob",
			IsDefault:    0,
			RemoteFolder: sql.NullString{String: "", Valid: false},
		},
	}

	text, buttons := renderDriveManagerView(drives)
	if !strings.Contains(text, "已绑定的网盘:") {
		t.Errorf("文案未包含已绑定网盘: %s", text)
	}
	if !strings.Contains(text, "MEGA") || !strings.Contains(text, "alice@example.com") {
		t.Errorf("未正确渲染网盘 1: %s", text)
	}
	if !strings.Contains(text, "(默认)") {
		t.Errorf("未标记默认网盘: %s", text)
	}

	// 必须包含核心管理按钮
	for _, expected := range []string{"storage_check", "remote_folder_menu", "dupscan_open"} {
		if !hasButton(buttons, expected) {
			t.Errorf("网盘管理面板缺失按钮: %s", expected)
		}
	}

	// 必须包含单盘操作
	if !hasButton(buttons, "drive_unbind_confirm_drv-1") {
		t.Errorf("缺失解绑按钮 drv-1")
	}
	if !hasButton(buttons, "drive_set_default_drv-2") {
		t.Errorf("缺失设默认按钮 drv-2")
	}

	// 「➕ 绑定其他网盘」必须绑定到 drive_bind_menu，绝不能是 noop
	if !hasButton(buttons, "drive_bind_menu") {
		t.Errorf("缺失「➕ 绑定其他网盘」(drive_bind_menu) 按钮")
	}

	for _, row := range buttons {
		for _, b := range row {
			if b.Data == "noop" || b.Data == "" {
				t.Errorf("网盘管理面板存在死按钮: %+v", b)
			}
		}
	}
}

// TestDriveBindMenu 验证绑定菜单包含全部可用网盘以及返回按钮。
func TestDriveBindMenu(t *testing.T) {
	app := &App{log: quietApp()}
	tg := withFakeTG(app)

	cb := tgclient.CallbackContext{
		ChatID: 1001,
		MsgID:  2002,
		UserID: 42,
	}

	if err := app.editDriveBindMenu(context.Background(), cb); err != nil {
		t.Fatalf("editDriveBindMenu 失败: %v", err)
	}

	if len(tg.edits) != 1 {
		t.Fatalf("未调用 EditWithButtons，edits 数量: %d", len(tg.edits))
	}

	if !strings.Contains(tg.edits[0], "绑定网盘") {
		t.Errorf("文案不符: %s", tg.edits[0])
	}

	if len(tg.editBtns) != 1 {
		t.Fatalf("缺失编辑按钮")
	}
	buttons := tg.editBtns[0]

	expectedProviders := []string{
		"drive_bind_mega", "drive_bind_protondrive",
		"drive_bind_webdav", "drive_bind_oss",
		"drive_bind_pikpak", "drive_bind_filen",
		"drive_bind_pcloud",
	}
	for _, p := range expectedProviders {
		if !hasButton(buttons, p) {
			t.Errorf("绑定菜单缺失服务: %s", p)
		}
	}

	// 必须有返回网盘管理按钮
	if !hasButton(buttons, "drive_manager_back") {
		t.Errorf("绑定菜单缺失「🔙 返回网盘管理」按钮")
	}

	for _, row := range buttons {
		for _, b := range row {
			if b.Data == "noop" || b.Data == "" {
				t.Errorf("绑定菜单存在死按钮: %+v", b)
			}
		}
	}
}

// TestDriveManagerNavigationCycle 验证「绑定其他网盘」与「返回网盘管理」之间的完整流转闭环。
func TestDriveManagerNavigationCycle(t *testing.T) {
	app := &App{
		d1c: mockD1WithRows([]map[string]any{
			{
				"id":            "drv-1",
				"user_id":       "42",
				"type":          "mega",
				"name":          "mega-alice@example.com",
				"status":        "active",
				"is_default":    float64(1),
				"remote_folder": "Photos",
				"config_data":   "{}",
			},
		}),
		log: quietApp(),
	}
	tg := withFakeTG(app)

	// 1. 用户点击「➕ 绑定其他网盘」 (drive_bind_menu)
	if err := app.handleCallback(context.Background(), callbackUpdate(42, "drive_bind_menu")); err != nil {
		t.Fatalf("handleCallback(drive_bind_menu) 报错: %v", err)
	}

	if len(tg.edits) != 1 || !strings.Contains(tg.edits[0], "绑定网盘") {
		t.Fatalf("未能成功切入绑定菜单: edits=%v", tg.edits)
	}
	if !hasButton(tg.editBtns[0], "drive_manager_back") {
		t.Fatal("绑定菜单没有返回按钮")
	}

	// 2. 用户在绑定菜单点击「🔙 返回网盘管理」 (drive_manager_back)
	if err := app.handleCallback(context.Background(), callbackUpdate(42, "drive_manager_back")); err != nil {
		t.Fatalf("handleCallback(drive_manager_back) 报错: %v", err)
	}

	if len(tg.edits) != 2 || !strings.Contains(tg.edits[1], "网盘管理中心") {
		t.Fatalf("未能成功返回网盘管理中心: edits=%v", tg.edits)
	}
	if !hasButton(tg.editBtns[1], "drive_bind_menu") {
		t.Fatal("返回后的网盘管理中心缺失「➕ 绑定其他网盘」按钮")
	}
}

// TestDriveBindProviderCallback 验证绑定菜单中点击具体服务能顺利唤起对应服务绑定会话。
func TestDriveBindProviderCallback(t *testing.T) {
	app := &App{
		bindSessions: newFakeMemorySession(),
		log:          quietApp(),
	}
	tg := withFakeTG(app)

	if err := app.handleCallback(context.Background(), callbackUpdate(42, "drive_bind_webdav")); err != nil {
		t.Fatalf("handleCallback(drive_bind_webdav) 报错: %v", err)
	}

	sess, err := app.bindSessions.Get(context.Background(), "42")
	if err != nil || sess == nil {
		t.Fatalf("未成功启动 WebDAV 绑定会话: sess=%v, err=%v", sess, err)
	}
	if sess.CurrentStep != "WEBDAV:WAIT_URL" {
		t.Errorf("当前会话步骤为 %s, 期望 WEBDAV:WAIT_URL", sess.CurrentStep)
	}

	// 确认给用户发送了首步提示
	if len(tg.sent) != 1 || !strings.Contains(tg.sent[0], "WebDAV 服务器地址") {
		t.Errorf("未向用户发送 WebDAV 提示信息: sent=%v", tg.sent)
	}
}
