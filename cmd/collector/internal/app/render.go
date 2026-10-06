package app

import (
	"context"
	"fmt"

	"github.com/youngsx/drive-collector/cmd/collector/internal/dispatcher"
)

// App 实现 Dispatcher 需要的 TaskReader 与 Renderer。
//
// 放在本文件而不是 dispatcher 包里:渲染文案依赖 store 的字段形态,
// 而 store 不该知道「消息长什么样」。方向是 app → dispatcher,
// 反过来会成环。

// UserTasks 实现 dispatcher.TaskReader。
func (a *App) UserTasks(ctx context.Context, userID string, limit int) ([]dispatcher.TaskBrief, error) {
	if a.repo == nil {
		return nil, nil
	}
	tasks, err := a.repo.FindByUserId(ctx, userID, limit)
	if err != nil {
		return nil, err
	}
	out := make([]dispatcher.TaskBrief, 0, len(tasks))
	for _, t := range tasks {
		out = append(out, dispatcher.TaskBrief{
			ID:       t.ID,
			FileName: t.FileName.String,
			Status:   string(t.Status),
			Size:     t.FileSize,
		})
	}
	return out, nil
}

// Welcome 渲染 /start。
func (a *App) Welcome(userID string) string {
	return "👋 欢迎使用文件转存机器人\n\n" +
		"直接把文件或图片发给我,我会上传到你的网盘。\n" +
		"发 /help 查看可用命令。"
}

// Help 渲染 /help —— 必须如实反映 B 方案只实现了哪些命令。
//
// 列一个不存在的命令比不列更糟:用户会照着敲,然后得到「暂未迁移」。
func (a *App) Help() string {
	return "📖 <b>可用命令</b>\n\n" +
		"<code>/start</code>    开始使用\n" +
		"<code>/status</code>   查看我的任务\n" +
		"<code>/files</code>    查看已转存文件\n" +
		"<code>/drive</code>    网盘绑定\n" +
		"<code>/set_remote_folder &lt;目录&gt;</code>  设置保存目录\n" +
		"<code>/help</code>     本帮助\n\n" +
		"直接把文件发给我即可转存。"
}

// Status 渲染 /status。
func (a *App) Status(userID string, tasks []dispatcher.TaskBrief) string {
	if len(tasks) == 0 {
		return "📊 你还没有任务。\n\n直接把文件发给我就行。"
	}
	out := "📊 <b>最近任务</b>\n\n"
	for _, t := range tasks {
		icon := statusIcon(t.Status)
		out += fmt.Sprintf("%s %s\n   <code>%s · %s</code>\n",
			icon, t.FileName, t.Status, formatSize(t.Size))
	}
	return out
}

// statusIcon 给状态配图标 —— 与 JS 侧保持一致的观感。
func statusIcon(status string) string {
	switch status {
	case "completed":
		return "✅"
	case "failed":
		return "❌"
	case "cancelled":
		return "🚫"
	case "uploading":
		return "⬆️"
	case "downloading":
		return "⬇️"
	default:
		return "⏳"
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

// 编译期断言:App 必须满足 Dispatcher 的两个依赖接口。
//
// 少一个会在调用时才报错(接口是 nil 时静默跳过命令),那时候
// 线上表现为「bot 不回命令」,极难定位。
var (
	_ dispatcher.TaskReader = (*App)(nil)
	_ dispatcher.Renderer   = (*App)(nil)
)
