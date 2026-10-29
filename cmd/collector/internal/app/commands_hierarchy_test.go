package app

import (
	"context"
	"database/sql"
	"strings"
	"sync"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	"github.com/youngsx/drive-collector/cmd/collector/internal/bindingsession"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

type memBindSessions struct {
	mu       sync.Mutex
	sessions map[string]*bindingsession.Session
}

func newMemBindSessions() *memBindSessions {
	return &memBindSessions{sessions: make(map[string]*bindingsession.Session)}
}

func (m *memBindSessions) Start(ctx context.Context, userID, step string, data map[string]string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[userID] = &bindingsession.Session{CurrentStep: step, Data: data}
	return nil
}

func (m *memBindSessions) Get(ctx context.Context, userID string) (*bindingsession.Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[userID], nil
}

func (m *memBindSessions) Update(ctx context.Context, userID, step string, data map[string]string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.sessions[userID] = &bindingsession.Session{CurrentStep: step, Data: data}
	return nil
}

func (m *memBindSessions) Clear(ctx context.Context, userID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, userID)
	return nil
}

// TestCancelCommand_Cascade 验证 /cancel 逃生级联
func TestCancelCommand_Cascade(t *testing.T) {
	ctx := context.Background()

	t.Run("Level 1: 绑定会话活动中直接取消退出", func(t *testing.T) {
		bindSessions := newMemBindSessions()
		_ = bindSessions.Start(ctx, "1001", "MEGA:WAIT_EMAIL", nil)

		app := &App{
			bindSessions: bindSessions,
			log:          quietApp(),
		}
		tg := withFakeTG(app)
		msg := messageInfo{
			SenderID: 1001,
			ChatID:   1001,
			Text:     "/cancel",
		}

		err := app.handleCancelCommand(ctx, msg)
		if err != nil {
			t.Fatalf("handleCancelCommand 失败: %v", err)
		}
		sess, _ := bindSessions.Get(ctx, "1001")
		if sess != nil {
			t.Errorf("期望绑定会话已被清空，但仍存在: %+v", sess)
		}
		if len(tg.sent) == 0 {
			t.Fatal("未发送任何响应")
		}
		if !strings.Contains(tg.sent[len(tg.sent)-1], "已退出当前网盘绑定流程") {
			t.Errorf("响应文案不符合预期: %s", tg.sent[len(tg.sent)-1])
		}
	})

	t.Run("Level 3: 活跃任务快捷引导", func(t *testing.T) {
		repo := &statusRepo{
			fakeRepo: &fakeRepo{},
			active: []store.Task{
				{
					ID:       "task-123",
					UserID:   "1003",
					Status:   "downloading",
					FileName: sql.NullString{String: "big_video.mp4", Valid: true},
				},
			},
		}
		app := newStatusApp(repo)
		tg := withFakeTG(app)
		msg := messageInfo{
			SenderID: 1003,
			ChatID:   1003,
			Text:     "/cancel",
		}

		err := app.handleCancelCommand(ctx, msg)
		if err != nil {
			t.Fatalf("handleCancelCommand 失败: %v", err)
		}
		if len(tg.sent) == 0 {
			t.Fatal("未发送任何响应")
		}
		lastMsg := tg.sent[len(tg.sent)-1]
		if !strings.Contains(lastMsg, "big_video.mp4") {
			t.Errorf("期望包含正在进行的任务名，实际收到: %s", lastMsg)
		}
		if !strings.Contains(lastMsg, "取消转存任务") {
			t.Errorf("期望包含取消指引，实际收到: %s", lastMsg)
		}
	})

	t.Run("Level 4: 闲置状态降级引导", func(t *testing.T) {
		app := &App{log: quietApp()}
		tg := withFakeTG(app)
		msg := messageInfo{
			SenderID: 1004,
			ChatID:   1004,
			Text:     "/cancel",
		}

		err := app.handleCancelCommand(ctx, msg)
		if err != nil {
			t.Fatalf("handleCancelCommand 失败: %v", err)
		}
		if len(tg.sent) == 0 {
			t.Fatal("未发送任何响应")
		}
		lastMsg := tg.sent[len(tg.sent)-1]
		if !strings.Contains(lastMsg, "当前处于闲置状态") {
			t.Errorf("期望包含闲置提示，实际收到: %s", lastMsg)
		}
		if !strings.Contains(lastMsg, "/drive") || !strings.Contains(lastMsg, "/status") {
			t.Errorf("期望包含快捷指令引导，实际收到: %s", lastMsg)
		}
	})
}

// TestAdminCommand_Routing 验证 /admin 控制台鉴权与渲染
func TestAdminCommand_Routing(t *testing.T) {
	ctx := context.Background()
	authGuard := &fakeAuthorizer{
		perms: map[string]map[auth.Action]bool{
			"888": {
				auth.ActionMaintenanceBypass: true,
			},
		},
	}

	t.Run("普通用户访问 /admin 拒绝权限", func(t *testing.T) {
		app := &App{
			auth: authGuard,
			log:  quietApp(),
		}
		tg := withFakeTG(app)
		msg := messageInfo{
			SenderID: 999,
			ChatID:   999,
			Text:     "/admin",
		}

		err := app.routeCommand(ctx, msg)
		if err != nil {
			t.Fatalf("routeCommand 报错: %v", err)
		}
		if len(tg.sent) == 0 {
			t.Fatal("未收到任何响应")
		}
		if !strings.Contains(tg.sent[0], "无权限") {
			t.Errorf("期望收到无权限提示，实际收到: %s", tg.sent[0])
		}
	})

	t.Run("管理员访问 /admin 展示控制台面板与各子系统导航", func(t *testing.T) {
		app := &App{
			auth: authGuard,
			log:  quietApp(),
		}
		tg := withFakeTG(app)
		msg := messageInfo{
			SenderID: 888,
			ChatID:   888,
			Text:     "/admin",
		}

		err := app.routeCommand(ctx, msg)
		if err != nil {
			t.Fatalf("routeCommand 报错: %v", err)
		}
		if len(tg.sent) == 0 {
			t.Fatal("未收到任何响应")
		}
		if !strings.Contains(tg.sent[0], "管理员控制台") {
			t.Errorf("期望收到管理员控制台，实际收到: %s", tg.sent[0])
		}
		if len(tg.sendBtns) == 0 || len(tg.sendBtns[0]) == 0 {
			t.Fatal("控制台未挂载导航功能按钮")
		}
	})
}

// TestCommandsHierarchy_PrunedAndClean 验证命令列表已精简，高阶与低阶职责分明
func TestCommandsHierarchy_PrunedAndClean(t *testing.T) {
	common := tgclient.CommonBotCommands()
	if len(common) != 6 {
		t.Fatalf("期望 6 个通用命令，实际得到 %d: %+v", len(common), common)
	}

	cmdNames := make(map[string]bool)
	for _, c := range common {
		cmdNames[c.Command] = true
	}

	for _, expected := range []string{"start", "drive", "files", "status", "cancel", "help"} {
		if !cmdNames[expected] {
			t.Errorf("缺少通用命令: /%s", expected)
		}
	}

	// 验证已被收拢、不再出现在顶级通用菜单里的低频指令
	for _, pruned := range []string{"remote_folder", "scan_dup", "task_queue", "users", "diagnosis", "open_service", "close_service", "ban", "unban", "pro_admin", "de_admin"} {
		if cmdNames[pruned] {
			t.Errorf("命令 /%s 不应出现在顶级通用命令列表中", pruned)
		}
	}

	admin := tgclient.AdminBotCommands()
	if len(admin) != 7 {
		t.Fatalf("期望 7 个管理员命令，实际得到 %d: %+v", len(admin), admin)
	}
	adminCmdNames := make(map[string]bool)
	for _, c := range admin {
		adminCmdNames[c.Command] = true
	}
	if !adminCmdNames["admin"] {
		t.Errorf("管理员命令列表中缺少 /admin 控制台命令")
	}
}
