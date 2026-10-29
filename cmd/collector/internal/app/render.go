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

// Help 渲染 /help —— 如实反映当前层次化命令结构。
func (a *App) Help(ctx context.Context, userID string) string {
	base := "📖 <b>可用命令</b>\n\n" +
		"<code>/start</code>    开始使用\n" +
		"<code>/drive</code>    网盘与保存目录管理\n" +
		"<code>/files</code>    查看已转存文件\n" +
		"<code>/status</code>   查看传输任务状态\n" +
		"<code>/cancel</code>   取消当前会话或正在进行的任务\n" +
		"<code>/help</code>     查看本帮助\n\n" +
		"💡 <i>进阶功能：可在 <code>/drive</code> 中设置保存目录或扫描重复文件。</i>\n\n" +
		"直接把文件发给即可转存。"
	if !a.can(ctx, userID, auth.ActionMaintenanceBypass) {
		return base
	}
	out := base + "\n\n<b>管理员工具</b>\n" +
		"<code>/admin</code> - 管理员控制台（整合诊断、全局队列、用户管理等）\n\n" +
		"<i>CLI 快捷命令：</i>\n" +
		"<code>/users</code> - 查看用户列表\n" +
		"<code>/task_queue</code> - 查看全局任务队列\n" +
		"<code>/diagnosis</code> - 系统诊断\n" +
		"<code>/open_service</code> - 开启公开访问\n" +
		"<code>/close_service</code> - 进入维护模式\n" +
		"<code>/ban</code> - 封禁用户\n" +
		"<code>/unban</code> - 解封用户"
	if a.ownerID != "" && userID == a.ownerID {
		out += "\n<code>/pro_admin</code> - 设为管理员\n" +
			"<code>/de_admin</code> - 取消管理员"
	}
	return out
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
var _ dispatcher.Renderer = (*App)(nil)
