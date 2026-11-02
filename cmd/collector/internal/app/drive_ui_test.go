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
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/d1"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
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

// TestDriveManagerView_ReauthButtons 验证网盘管理中心每个已绑定网盘均包含「🔑 更新凭证」按钮。
func TestDriveManagerView_ReauthButtons(t *testing.T) {
	drives := []drive.Drive{
		{
			ID:        "drv-1",
			UserID:    "42",
			Type:      "mega",
			Name:      "mega-alice@example.com",
			IsDefault: 1,
		},
		{
			ID:        "drv-2",
			UserID:    "42",
			Type:      "webdav",
			Name:      "webdav-bob",
			IsDefault: 0,
		},
	}

	_, buttons := renderDriveManagerView(drives)
	if !hasButton(buttons, "drive_reauth_drv-1") {
		t.Errorf("网盘管理面板缺失 drv-1 重新更新凭证按钮")
	}
	if !hasButton(buttons, "drive_reauth_drv-2") {
		t.Errorf("网盘管理面板缺失 drv-2 重新更新凭证按钮")
	}

	// 验证按钮文案
	foundText1, foundText2 := false, false
	for _, row := range buttons {
		for _, b := range row {
			if b.Data == "drive_reauth_drv-1" && strings.Contains(b.Text, "更新凭证") {
				foundText1 = true
			}
			if b.Data == "drive_reauth_drv-2" && strings.Contains(b.Text, "更新凭证") {
				foundText2 = true
			}
		}
	}
	if !foundText1 || !foundText2 {
		t.Errorf("凭证更新按钮文案不正确: found1=%v, found2=%v", foundText1, foundText2)
	}
}

// TestReauthCallback_SingleDrive 验证单盘场景下点击更新凭证直达向导并保留原有目录。
func TestReauthCallback_SingleDrive(t *testing.T) {
	app := &App{
		bindSessions: newFakeMemorySession(),
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

	// 点击通用的 drive_reauth 入口
	if err := app.handleCallback(context.Background(), callbackUpdate(42, "drive_reauth")); err != nil {
		t.Fatalf("handleCallback(drive_reauth) 报错: %v", err)
	}

	sess, err := app.bindSessions.Get(context.Background(), "42")
	if err != nil || sess == nil {
		t.Fatalf("未成功启动会话: %v", err)
	}
	if sess.Data["is_reauth"] != "true" {
		t.Errorf("期望 is_reauth 为 true, 实际: %s", sess.Data["is_reauth"])
	}
	if sess.Data["reauth_drive_id"] != "drv-1" {
		t.Errorf("期望 reauth_drive_id 为 drv-1, 实际: %s", sess.Data["reauth_drive_id"])
	}

	if len(tg.sent) != 1 {
		t.Fatalf("期望发送 1 条提示消息, 实际: %d", len(tg.sent))
	}
	prompt := tg.sent[0]
	if !strings.Contains(prompt, "重新更新网盘凭证") || !strings.Contains(prompt, "保留保存目录等配置") {
		t.Errorf("引导文案未包含重设凭证及保留目录提示: %s", prompt)
	}
}

// TestReauthCallback_MultiDriveMenu 验证多网盘时点击 drive_reauth 弹出网盘选择面板。
func TestReauthCallback_MultiDriveMenu(t *testing.T) {
	app := &App{
		bindSessions: newFakeMemorySession(),
		d1c: mockD1WithRows([]map[string]any{
			{
				"id":         "drv-1",
				"user_id":    "42",
				"type":       "mega",
				"name":       "mega-alice@example.com",
				"status":     "active",
				"is_default": float64(1),
			},
			{
				"id":         "drv-2",
				"user_id":    "42",
				"type":       "webdav",
				"name":       "webdav-bob",
				"status":     "active",
				"is_default": float64(0),
			},
		}),
		log: quietApp(),
	}
	tg := withFakeTG(app)

	// 点击通用的 drive_reauth 入口
	if err := app.handleCallback(context.Background(), callbackUpdate(42, "drive_reauth")); err != nil {
		t.Fatalf("handleCallback(drive_reauth) 报错: %v", err)
	}

	if len(tg.edits) == 0 && len(tg.sent) == 0 {
		t.Fatalf("期望呈现选择面板，但未发送或编辑消息")
	}

	var menuBtns [][]tgclient.Button
	if len(tg.editBtns) > 0 {
		menuBtns = tg.editBtns[0]
	} else if len(tg.sendBtns) > 0 {
		menuBtns = tg.sendBtns[0]
	}

	if !hasButton(menuBtns, "drive_reauth_drv-1") || !hasButton(menuBtns, "drive_reauth_drv-2") {
		t.Errorf("多盘选择菜单缺失对应网盘选项: %v", menuBtns)
	}
}

// TestReauthCommand 验证 /reauth 指令能够顺利路由并触发凭证更新。
func TestReauthCommand(t *testing.T) {
	app := &App{
		bindSessions: newFakeMemorySession(),
		d1c: mockD1WithRows([]map[string]any{
			{
				"id":         "drv-1",
				"user_id":    "42",
				"type":       "protondrive",
				"name":       "proton-user@proton.me",
				"status":     "active",
				"is_default": float64(1),
			},
		}),
		log: quietApp(),
	}
	tg := withFakeTG(app)

	msg := messageInfo{
		ChatID:   1001,
		SenderID: 42,
		Text:     "/reauth",
	}

	if err := app.routeCommand(context.Background(), msg); err != nil {
		t.Fatalf("/reauth 执行报错: %v", err)
	}

	sess, err := app.bindSessions.Get(context.Background(), "42")
	if err != nil || sess == nil {
		t.Fatalf("未成功启动会话: %v", err)
	}
	if sess.Data["is_reauth"] != "true" || sess.Data["reauth_drive_id"] != "drv-1" {
		t.Errorf("会话参数不符合预期: %+v", sess)
	}
	if len(tg.sent) != 1 || !strings.Contains(tg.sent[0], "PROTONDRIVE") {
		t.Errorf("未正确向用户展示 Proton 更新凭证提示: %v", tg.sent)
	}
}

// TestReauthCancel 验证在重新更新凭证流程中发送 /cancel 能友好退出并清理会话。
func TestReauthCancel(t *testing.T) {
	memSession := newFakeMemorySession()
	_ = memSession.Start(context.Background(), "42", "MEGA:WAIT_USER", map[string]string{
		"is_reauth":       "true",
		"reauth_drive_id": "drv-1",
	})

	app := &App{
		bindSessions: memSession,
		d1c:          mockD1WithRows(nil),
		log:          quietApp(),
	}
	tg := withFakeTG(app)

	msg := messageInfo{
		ChatID:   1001,
		SenderID: 42,
		Text:     "/cancel",
	}

	consumed := app.handleBindInput(context.Background(), msg, msg.Text)
	if !consumed {
		t.Fatalf("handleBindInput 应该消费 /cancel 指令")
	}

	sess, _ := app.bindSessions.Get(context.Background(), "42")
	if sess != nil {
		t.Errorf("取消后会话应被清理，实际仍存在: %+v", sess)
	}

	if len(tg.sent) != 1 || !strings.Contains(tg.sent[0], "已取消网盘凭证更新") {
		t.Errorf("未收到凭证更新取消提示: %v", tg.sent)
	}
}

// TestReauthFlow_CreateBoundDriveUpdatesExisting 验证重新更新凭证时，更新指定目标网盘的 config_data 而不是新建记录。
func TestReauthFlow_CreateBoundDriveUpdatesExisting(t *testing.T) {
	updatedTarget := false
	hc := &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			bodyBytes, _ := io.ReadAll(req.Body)
			bodyStr := string(bodyBytes)
			if strings.Contains(bodyStr, "UPDATE drives SET config_data") && strings.Contains(bodyStr, "drv-target") {
				updatedTarget = true
			}
			resp := map[string]any{
				"result": []map[string]any{
					{
						"results": []map[string]any{
							{
								"id":            "drv-target",
								"user_id":       "42",
								"type":          "mega",
								"name":          "mega-old@example.com",
								"status":        "active",
								"is_default":    float64(1),
								"remote_folder": "MyFolder",
								"config_data":   `{"pass":"old_pass"}`,
							},
						},
						"success": true,
					},
				},
				"success": true,
				"errors":  []any{},
			}
			respBody, _ := json.Marshal(resp)
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewReader(respBody)),
				Header:     make(http.Header),
			}, nil
		}),
	}
	d1c, _ := d1.New(d1.Config{
		AccountID:  "ui-acc",
		DatabaseID: "ui-db",
		Token:      "ui-tok",
		HTTPClient: hc,
	})

	app := &App{
		d1c:    d1c,
		drives: store.NewDriveRepository(d1c),
		log:    quietApp(),
	}

	newCfg := drive.DriveConfig{Pass: "new_secret_pass"}
	res := drive.BindResult{
		Success:   true,
		DriveName: "mega-new@example.com",
		Config:    &newCfg,
	}

	err := app.createBoundDrive(context.Background(), "42", drive.TypeMega, res, "drv-target")
	if err != nil {
		t.Fatalf("createBoundDrive 报错: %v", err)
	}

	if !updatedTarget {
		t.Errorf("期望更新 drv-target 的配置")
	}
}

// TestReauthFlow_CreateBoundDriveNonexistentTargetFails 验证目标网盘 ID 不存在时严禁 Fallthrough 误改其它盘。
func TestReauthFlow_CreateBoundDriveNonexistentTargetFails(t *testing.T) {
	d1c := mockD1WithRows([]map[string]any{
		{
			"id":            "drv-other",
			"user_id":       "42",
			"type":          "mega",
			"name":          "mega-other@example.com",
			"status":        "active",
			"is_default":    float64(1),
			"remote_folder": "OtherFolder",
			"config_data":   `{"pass":"pass"}`,
		},
	})
	app := &App{
		d1c:    d1c,
		drives: store.NewDriveRepository(d1c),
		log:    quietApp(),
	}

	newCfg := drive.DriveConfig{Pass: "new_secret_pass"}
	res := drive.BindResult{
		Success:   true,
		DriveName: "mega-other@example.com",
		Config:    &newCfg,
	}

	err := app.createBoundDrive(context.Background(), "42", drive.TypeMega, res, "drv-ghost")
	if err == nil || !strings.Contains(err.Error(), "不存在或已被解绑") {
		t.Fatalf("指定不存在的盘 ID 时必须报错阻止 Fallthrough, 实际返回: %v", err)
	}
}

// TestReauthCallback_NonexistentDrive 验证回调携带已解绑网盘 ID 时给出友好拦截。
func TestReauthCallback_NonexistentDrive(t *testing.T) {
	app := &App{
		bindSessions: newFakeMemorySession(),
		d1c:          mockD1WithRows(nil),
		log:          quietApp(),
	}
	tg := withFakeTG(app)

	if err := app.handleCallback(context.Background(), callbackUpdate(42, "drive_reauth_ghost")); err != nil {
		t.Fatalf("handleCallback 报错: %v", err)
	}

	if len(tg.sent) != 1 || !strings.Contains(tg.sent[0], "未找到对应网盘") {
		t.Errorf("期望返回未找到对应网盘提示, 实际输出: %v", tg.sent)
	}
}

// TestStorageInvalidate_ClearsMemoryAndCooldown 验证凭证更新后清理容量缓存及冷却时间。
func TestStorageInvalidate_ClearsMemoryAndCooldown(t *testing.T) {
	app := &App{
		storageMem:       map[string]storageMemEntry{"storage_42_drv-1": {}},
		storageRefreshAt: map[string]time.Time{"refresh_42_drv-1": time.Now()},
		log:              quietApp(),
	}

	app.storageInvalidate("42", "drv-1")

	if _, ok := app.storageMem["storage_42_drv-1"]; ok {
		t.Errorf("storageMem 缓存未被清理")
	}
	if _, ok := app.storageRefreshAt["refresh_42_drv-1"]; ok {
		t.Errorf("storageRefreshAt 刷新冷却未被清理")
	}
}

// TestRebindAliasCommand 验证 /rebind 命令与 /reauth 行为一致。
func TestRebindAliasCommand(t *testing.T) {
	app := &App{
		bindSessions: newFakeMemorySession(),
		d1c: mockD1WithRows([]map[string]any{
			{
				"id":         "drv-1",
				"user_id":    "42",
				"type":       "mega",
				"name":       "mega-alice@example.com",
				"status":     "active",
				"is_default": float64(1),
			},
		}),
		log: quietApp(),
	}
	tg := withFakeTG(app)

	msg := messageInfo{
		ChatID:   1001,
		SenderID: 42,
		Text:     "/rebind",
	}

	if err := app.routeCommand(context.Background(), msg); err != nil {
		t.Fatalf("/rebind 执行报错: %v", err)
	}

	if len(tg.sent) == 0 {
		t.Errorf("期望发送提示消息")
	}

	sess, err := app.bindSessions.Get(context.Background(), "42")
	if err != nil || sess == nil {
		t.Fatalf("未成功启动会话: %v", err)
	}
	if sess.Data["is_reauth"] != "true" || sess.Data["reauth_drive_id"] != "drv-1" {
		t.Errorf("会话参数不符合预期: %+v", sess)
	}
}



