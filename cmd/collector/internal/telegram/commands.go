package telegram

import (
	"context"
	"errors"

	"github.com/gotd/td/tg"
)

// CommonBotCommands 返回普通用户可见的 Bot 命令菜单。
func CommonBotCommands() []tg.BotCommand {
	return []tg.BotCommand{
		{Command: "start", Description: "🚀 启动机器人"},
		{Command: "drive", Description: "🔑 绑定或管理网盘"},
		{Command: "files", Description: "📁 浏览已转存文件"},
		{Command: "scan_dup", Description: "🔍 查找网盘重复文件"},
		{Command: "status", Description: "📊 查看我的任务"},
		{Command: "remote_folder", Description: "📂 保存目录设置"},
		{Command: "help", Description: "📖 显示帮助菜单"},
	}
}

// AdminBotCommands 返回管理员专属的 Bot 命令菜单（包含普通命令与管理命令）。
func AdminBotCommands() []tg.BotCommand {
	adminOnly := []tg.BotCommand{
		{Command: "users", Description: "👥 用户列表"},
		{Command: "task_queue", Description: "📊 全局任务队列"},
		{Command: "diagnosis", Description: "🩺 系统诊断"},
		{Command: "open_service", Description: "🔓 开启服务"},
		{Command: "close_service", Description: "🔒 关闭服务"},
		{Command: "ban", Description: "🚫 封禁用户"},
		{Command: "unban", Description: "✅ 解封用户"},
		{Command: "pro_admin", Description: "👑 设置管理员"},
		{Command: "de_admin", Description: "🗑️ 取消管理员"},
	}
	res := make([]tg.BotCommand, 0, len(CommonBotCommands())+len(adminOnly))
	res = append(res, CommonBotCommands()...)
	res = append(res, adminOnly...)
	return res
}

// RegisterBotCommands 为普通用户和管理员分别设置专属的 Telegram Bot 命令菜单。
func (c *Client) RegisterBotCommands(ctx context.Context, ownerID int64) error {
	if c.tg == nil {
		return errors.New("telegram: client not initialized")
	}

	// 1. 设置默认菜单（所有用户可见）
	if _, err := c.tg.API().BotsSetBotCommands(ctx, &tg.BotsSetBotCommandsRequest{
		Scope:    &tg.BotCommandScopeDefault{},
		LangCode: "",
		Commands: CommonBotCommands(),
	}); err != nil {
		c.log.Warn("设置默认机器人命令失败", "err", err)
	} else {
		c.log.Info("已成功注册普通用户机器人命令")
	}

	// 2. 为管理员设置专属菜单
	if ownerID != 0 {
		peer, err := c.peerFor(ctx, ownerID)
		if err != nil {
			c.log.Warn("获取管理员 Peer 失败，跳过管理员专属菜单设置", "ownerId", ownerID, "err", err)
			return nil
		}
		if _, err := c.tg.API().BotsSetBotCommands(ctx, &tg.BotsSetBotCommandsRequest{
			Scope:    &tg.BotCommandScopePeer{Peer: peer},
			LangCode: "",
			Commands: AdminBotCommands(),
		}); err != nil {
			c.log.Warn("设置管理员专属命令失败", "ownerId", ownerID, "err", err)
		} else {
			c.log.Info("已成功注册管理员专属机器人命令", "ownerId", ownerID)
		}
	}
	return nil
}
