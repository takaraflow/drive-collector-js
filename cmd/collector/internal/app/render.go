package app

import (
	"context"
	"fmt"

	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/dispatcher"
)

// App 实现 Dispatcher 需要的 Renderer。
//
// 放在本文件而不是 dispatcher 包里:渲染文案依赖 store 的字段形态,
// 而 store 不该知道「消息长什么样」。方向是 app → dispatcher,
// 反过来会成环。

// Welcome 渲染 /start。
func (a *App) Welcome(userID string) string {
	return "👋 欢迎使用文件转存机器人\n\n" +
		"直接把文件或图片发给我,我会上传到你的网盘。\n" +
		"发 /help 查看可用命令。"
}

// Help 渲染 /help —— 必须如实反映当前只实现了哪些命令。
//
// 列一个不存在的命令比不列更糟:用户会照着敲,然后得到「暂未迁移」。
func (a *App) Help(ctx context.Context, userID string) string {
	base := "📖 <b>可用命令</b>\n\n" +
		"<code>/start</code>    开始使用\n" +
		"<code>/status</code>   查看我的任务(可加 <code>queue</code>/<code>user</code> 看队列或历史)\n" +
		"<code>/files</code>    查看已转存文件\n" +
		"<code>/drive</code>    网盘绑定\n" +
		"<code>/set_remote_folder &lt;目录&gt;</code>  设置保存目录\n" +
		"<code>/help</code>     本帮助\n\n" +
		"直接把文件发给我即可转存。"
	if !a.can(ctx, userID, auth.ActionMaintenanceBypass) {
		return base
	}
	// 管理员那一段与 JS STRINGS.system.help_admin 一致。
	// 刻意不列 /pro_admin /de_admin(JS 的 help_owner 有,Go 没实现)——
	// 列一个不存在的命令比不列更糟:用户会照着敲,然后得到「暂未迁移」。
	return base + "\n\n<b>管理员工具</b>\n" +
		"<code>/users</code> - 查看用户列表\n" +
		"<code>/task_queue</code> - 查看全局任务队列\n" +
		"<code>/diagnosis</code> - 系统诊断\n" +
		"<code>/open_service</code> - 开启公开访问\n" +
		"<code>/close_service</code> - 进入维护模式\n" +
		"<code>/ban</code> - 封禁用户\n" +
		"<code>/unban</code> - 解封用户"
}

// statusIcon 给状态配图标 —— 与 JS _getTaskStatusIcon 逐字一致。
func statusIcon(status contract.TaskStatus) string {
	switch status {
	case contract.StatusCompleted:
		return "✅"
	case contract.StatusFailed:
		return "❌"
	case contract.StatusCancelled:
		return "🚫"
	case contract.StatusQueued:
		return "🕒"
	case contract.StatusUploading:
		return "🔄"
	case contract.StatusDownloading, contract.StatusDownloaded:
		return "🔄"
	default:
		return "•"
	}
}

// formatSize 把字节数转成人看的单位。
func formatSize(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGT"[exp])
}

// 编译期断言:App 必须满足 Dispatcher 的 Renderer 接口。
//
// 少一个会在调用时才报错(接口是 nil 时静默跳过命令),那时候
// 线上表现为「bot 不回命令」,极难定位。
var _ dispatcher.Renderer = (*App)(nil)
