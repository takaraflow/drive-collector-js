package telegram

import (
	"context"
	"testing"
)

func TestBotCommandsLists(t *testing.T) {
	common := CommonBotCommands()
	if len(common) != 7 {
		t.Fatalf("expected 7 common commands, got %d", len(common))
	}
	expectedCommon := map[string]string{
		"start":         "🚀 启动机器人",
		"drive":         "🔑 绑定或管理网盘",
		"files":         "📁 浏览已转存文件",
		"scan_dup":      "🔍 查找网盘重复文件",
		"status":        "📊 查看我的任务",
		"remote_folder": "📂 保存目录设置",
		"help":          "📖 显示帮助菜单",
	}
	for _, cmd := range common {
		desc, ok := expectedCommon[cmd.Command]
		if !ok {
			t.Errorf("unexpected command in common: %s", cmd.Command)
		} else if desc != cmd.Description {
			t.Errorf("command %s desc mismatch: got %q, want %q", cmd.Command, cmd.Description, desc)
		}
	}

	admin := AdminBotCommands()
	if len(admin) != len(common)+9 {
		t.Fatalf("expected %d admin commands, got %d", len(common)+9, len(admin))
	}
	adminOnlyCommands := []string{"users", "task_queue", "diagnosis", "open_service", "close_service", "ban", "unban", "pro_admin", "de_admin"}
	adminMap := make(map[string]bool)
	for _, cmd := range admin {
		adminMap[cmd.Command] = true
	}
	for _, expected := range adminOnlyCommands {
		if !adminMap[expected] {
			t.Errorf("expected admin command %s not found in admin commands", expected)
		}
	}
}

func TestRegisterBotCommandsUninitialized(t *testing.T) {
	c := &Client{log: quiet()}
	err := c.RegisterBotCommands(context.Background(), 12345)
	if err == nil {
		t.Fatal("expected error when registering commands on uninitialized client, got nil")
	}
}
