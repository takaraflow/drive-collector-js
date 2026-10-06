package app

// /status —— 队列概览 + 活跃任务 + 取消/重试。
//
// 对应 JS 侧 Dispatcher._handleStatusCommand / _getGeneralStatus /
// _getUserStatus / _getQueueStatus / _renderUserQueueSummary /
// _getPersonalStatusButtons 与 cancel_*、retry_* 那组回调。
//
// 为什么放在 app 而不是 dispatcher:/files、/drive 已经在 app,原因相同 ——
// 取消/重试要写任务状态机,而 Dispatcher 的接口面只有「读权限 + 读任务」。
// 再往 Dispatcher 加一个写接口,只会让每个 mock 都多实现一个方法。
//
// 文案与 JS 侧 STRINGS.status / STRINGS.task 逐字一致:切换期两边可能
// 同时在跑,用户看到的必须是同一句话。

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// statusTaskLimit 是「最近任务 / 活跃任务」的条数上限(与 JS 侧一致)。
const statusTaskLimit = 10

// 文案与 JS 侧 STRINGS.status / STRINGS.task 逐字一致。
const (
	statusUserHeader  = "📊 <b>我的状态</b>"
	statusAdminHeader = "📊 <b>系统状态</b>"
	statusQueueTitle  = "📦 您的任务队列"
	statusHistory     = "👤 您的任务历史"
	statusSystemInfo  = "💻 管理员诊断信息"
	statusNoTasks     = "尚无任务记录。请直接向我发送文件、图片或链接来开始转存。"
	statusNoActive    = "✅ 当前没有排队或处理中任务。请直接向我发送文件或链接来开始转存。"
	statusActiveHint  = "可直接取消当前仍在排队或处理的任务。"

	statusCancelConfirm = "⚠️ <b>确认取消这个任务？</b>\n\n取消后需要重新发送文件或链接才能再次转存。"
	statusRetryConfirm  = "⚠️ <b>确认重试这个任务？</b>\n\n我会重新排队处理该任务。"

	statusCmdSent        = "指令已下达"
	statusTaskNotFound   = "任务已不存在或无权操作"
	statusActionCanceled = "已取消操作"
)

// startedAt 记录进程启动时刻 —— /status 的「运行时间」用。
var startedAt = time.Now()

// handleStatusCommand /status [queue|user|general] —— 子命令缺省是 general。
func (a *App) handleStatusCommand(ctx context.Context, msg messageInfo) error {
	sub := "general"
	if fields := strings.Fields(msg.Text); len(fields) > 1 {
		sub = strings.ToLower(fields[1])
	}

	text, buttons, err := a.statusView(ctx, fmt.Sprintf("%d", msg.SenderID), sub)
	if err != nil {
		a.log.Error("/status 渲染失败", "userId", msg.SenderID, "err", err)
		return a.tg.SendMessage(ctx, msg.ChatID, "❌ 状态查询失败,请稍后重试。")
	}
	return a.tg.SendWithButtons(ctx, msg.ChatID, text, buttons)
}

// queueOverview 是 /status 的数据源 —— 与 JS TaskRepository
// .getUserQueueOverview 返回的三段一一对应。
type queueOverview struct {
	counts      map[string]int
	activeTasks []store.Task
	recentTasks []store.Task
}

func (a *App) statusOverview(ctx context.Context, userID string) (queueOverview, error) {
	if a.repo == nil {
		return queueOverview{}, nil
	}
	counts, err := a.repo.CountByUserStatus(ctx, userID)
	if err != nil {
		return queueOverview{}, err
	}
	active, err := a.repo.FindActiveByUserId(ctx, userID, statusTaskLimit)
	if err != nil {
		return queueOverview{}, err
	}
	recent, err := a.repo.FindByUserId(ctx, userID, statusTaskLimit)
	if err != nil {
		return queueOverview{}, err
	}
	return queueOverview{counts: counts, activeTasks: active, recentTasks: recent}, nil
}

// statusView 渲染三种视图 + 操作按钮。
func (a *App) statusView(ctx context.Context, userID, sub string) (string, [][]tgclient.Button, error) {
	ov, err := a.statusOverview(ctx, userID)
	if err != nil {
		return "", nil, err
	}
	isAdmin := a.can(ctx, userID, auth.ActionMaintenanceBypass)

	var text string
	switch sub {
	case "queue":
		text = statusUserHeader + "\n\n" + renderQueueSummary(ov)
	case "user":
		text = statusUserHeader + "\n\n" + renderQueueSummary(ov) + "\n\n" +
			statusHistory + "\n\n" + renderTaskHistory(ov.recentTasks)
	default: // general
		header := statusUserHeader
		if isAdmin {
			header = statusAdminHeader
		}
		text = header + "\n\n" + a.renderDriveStatus(ctx, userID) + "\n\n" +
			renderQueueSummary(ov)
		if isAdmin {
			text += "\n\n" + statusSystemInfo + "\n" +
				fmt.Sprintf("⏱️ 运行时间: <code>%s</code>\n", formatUptime(time.Since(startedAt))) +
				"📡 服务状态: ✅ 正常"
		}
	}
	return text, statusButtons(ov, isAdmin), nil
}

// renderDriveStatus 「🔑 网盘绑定: …」一行。
func (a *App) renderDriveStatus(ctx context.Context, userID string) string {
	status := "❌ 未绑定"
	if a.drives != nil {
		d, err := a.drives.DefaultDrive(ctx, userID)
		if err != nil {
			a.log.Warn("查默认网盘失败", "userId", userID, "err", err)
		} else if d != nil {
			status = "✅ 已绑定 (" + strings.ToUpper(d.Type) + ")"
		}
	}
	return "🔑 网盘绑定: " + status
}

// renderQueueSummary 队列概览:排队数、处理中数、活跃任务列表。
func renderQueueSummary(ov queueOverview) string {
	queued := ov.counts["queued"]
	processing := ov.counts["downloading"] + ov.counts["downloaded"] + ov.counts["uploading"]

	out := statusQueueTitle + "\n"
	out += fmt.Sprintf("🕒 排队中: %d\n", queued)
	out += fmt.Sprintf("🔄 处理中: %d\n", processing)

	if len(ov.activeTasks) == 0 {
		return out + statusNoActive + "\n"
	}
	out += "\n⚡ 活跃任务\n"
	for i, t := range ov.activeTasks {
		out += renderTaskItem(t, i) + "\n"
	}
	return out + statusActiveHint + "\n"
}

// renderTaskHistory 历史任务列表(空时给引导文案)。
func renderTaskHistory(tasks []store.Task) string {
	if len(tasks) == 0 {
		return statusNoTasks
	}
	out := ""
	for i, t := range tasks {
		out += renderTaskItem(t, i) + "\n"
	}
	return out
}

// renderTaskItem 一行任务:「1. 🔄 <code>名字</code> (下载中)」。
func renderTaskItem(t store.Task, index int) string {
	name := t.FileName.String
	if name == "" {
		name = "未知文件"
	}
	return fmt.Sprintf("%d. %s <code>%s</code> (%s)",
		index+1, statusIcon(t.Status), escapeHTMLText(name), statusText(t.Status))
}

// statusText 状态的中文名 —— 与 JS _getTaskStatusText 一致。
func statusText(s contract.TaskStatus) string {
	switch s {
	case "completed":
		return "完成"
	case "failed":
		return "失败"
	case "cancelled":
		return "已取消"
	case "queued":
		return "排队中"
	case "downloading":
		return "下载中"
	case "downloaded":
		return "等待转存"
	case "uploading":
		return "上传中"
	default:
		return "未知"
	}
}

// statusButtons 操作按钮 —— 与 JS _getPersonalStatusButtons 一致。
//
// 管理员那三枚(用户列表 / 全局队列 / 系统诊断)挂在最后:它们指向
// 管理看板,普通用户看不到也不需要。
func statusButtons(ov queueOverview, isAdmin bool) [][]tgclient.Button {
	buttons := [][]tgclient.Button{}
	if len(ov.activeTasks) > 0 && ov.activeTasks[0].ID != "" {
		buttons = append(buttons, []tgclient.Button{
			{Text: "🚫 取消当前任务", Data: "cancel_confirm_" + ov.activeTasks[0].ID},
		})
	}
	for _, t := range ov.recentTasks {
		if t.Status == contract.StatusFailed && t.ID != "" {
			buttons = append(buttons, []tgclient.Button{
				{Text: "🔄 重试失败任务", Data: "retry_confirm_" + t.ID},
			})
			break
		}
	}
	buttons = append(buttons, []tgclient.Button{
		{Text: "📁 浏览文件", Data: "files_page_0"},
		{Text: "⚙️ 设置保存路径", Data: "remote_folder_menu"},
	})
	if isAdmin {
		buttons = append(buttons,
			[]tgclient.Button{
				{Text: statusBtnUserList, Data: "admin_users_open"},
				{Text: statusBtnTaskQueue, Data: "task_queue_open"},
			},
			[]tgclient.Button{{Text: statusBtnDiagnosis, Data: "diagnosis_run"}},
		)
	}
	return buttons
}

// handleStatusCallback 取消/重试/返回 —— 与 JS 那组同名回调一致。
func (a *App) handleStatusCallback(ctx context.Context, cb tgclient.CallbackContext, data string) error {
	answer := func(text string, alert bool) {
		if err := a.tg.AnswerCallback(ctx, cb.CallbackID, text, alert); err != nil {
			a.log.Warn("回应按钮失败", "err", err)
		}
	}

	switch {
	case data == "task_action_back", data == "status_general":
		answer(statusActionCanceled, false)
		return a.redrawStatus(ctx, cb)

	case strings.HasPrefix(data, "cancel_confirm_"):
		taskID := strings.TrimPrefix(data, "cancel_confirm_")
		answer("", false)
		return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, statusCancelConfirm,
			[][]tgclient.Button{
				{{Text: "保留任务", Data: "task_action_back"}},
				{{Text: "确认取消", Data: "cancel_execute_" + taskID}},
			})

	case strings.HasPrefix(data, "cancel_execute_"):
		taskID := strings.TrimPrefix(data, "cancel_execute_")
		answer(a.cancelTask(ctx, fmt.Sprintf("%d", cb.UserID), taskID), false)
		return nil

	case strings.HasPrefix(data, "retry_confirm_"):
		taskID := strings.TrimPrefix(data, "retry_confirm_")
		answer("", false)
		return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, statusRetryConfirm,
			[][]tgclient.Button{
				{{Text: "保留任务", Data: "task_action_back"}},
				{{Text: "确认重试", Data: "retry_execute_" + taskID}},
			})

	case strings.HasPrefix(data, "retry_execute_"):
		taskID := strings.TrimPrefix(data, "retry_execute_")
		answer(a.retryTask(ctx, fmt.Sprintf("%d", cb.UserID), taskID), false)
		return nil
	}
	return nil
}

// cancelTask / retryTask 先验归属再动状态机 —— 归属校验不能省:
// taskId 是回调数据里的明文,谁都能伪造。别人的任务必须打不动。
func (a *App) cancelTask(ctx context.Context, userID, taskID string) string {
	if !a.ownsTask(ctx, userID, taskID) {
		return statusTaskNotFound
	}
	if _, err := a.tasks.CancelTask(ctx, taskID); err != nil {
		a.log.Error("取消任务失败", "taskId", taskID, "err", err)
		return statusTaskNotFound
	}
	return statusCmdSent
}

func (a *App) retryTask(ctx context.Context, userID, taskID string) string {
	if !a.ownsTask(ctx, userID, taskID) {
		return statusTaskNotFound
	}
	if _, err := a.tasks.RetryTask(ctx, taskID); err != nil {
		a.log.Error("重试任务失败", "taskId", taskID, "err", err)
		return statusTaskNotFound
	}
	return statusCmdSent
}

// ownsTask 任务是否属于该用户。
//
// 管理员(task:cancel:any)对任何任务都算「有权」—— 与 JS 侧
// TaskManager.retryTask / cancelTask 的判定一致。不放行的话,
// /task_queue 的「重试本页失败任务」会对每个任务都返回「任务已不存在
// 或无权操作」:管理员看的是全站任务,归属校验却按「这是我的」判。
func (a *App) ownsTask(ctx context.Context, userID, taskID string) bool {
	t, err := a.repo.FindById(ctx, taskID)
	if err != nil {
		a.log.Error("查任务失败", "taskId", taskID, "err", err)
		return false
	}
	if t == nil {
		return false
	}
	if t.UserID == userID {
		return true
	}
	return a.canAdmin(ctx, userID, auth.ActionTaskCancelAny)
}

// redrawStatus 把消息重画回 /status 视图(取消操作后返回)。
func (a *App) redrawStatus(ctx context.Context, cb tgclient.CallbackContext) error {
	userID := fmt.Sprintf("%d", cb.UserID)
	text, buttons, err := a.statusView(ctx, userID, "general")
	if err != nil {
		a.log.Error("重画 /status 失败", "userId", userID, "err", err)
		return a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, "❌ 状态查询失败,请稍后重试。")
	}
	return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, text, buttons)
}

// editRemoteFolderMenu 「设置保存路径」按钮 —— 显示当前目录与改法。
//
// JS 侧是一串会话式菜单;这里只给「当前值 + 一行命令」。目录本来就
// 只有一个字段,做成多轮向导只是多几次点击,不换来任何东西。
func (a *App) editRemoteFolderMenu(ctx context.Context, cb tgclient.CallbackContext) error {
	userID := fmt.Sprintf("%d", cb.UserID)
	current := "未设置(存到网盘根目录)"
	if a.drives != nil {
		d, err := a.drives.DefaultDrive(ctx, userID)
		if err != nil {
			a.log.Warn("查默认网盘失败", "userId", userID, "err", err)
		} else if d != nil && d.RemoteFolder.Valid && d.RemoteFolder.String != "" {
			current = "/" + strings.Trim(d.RemoteFolder.String, "/")
		}
	}
	return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID,
		fmt.Sprintf("📂 <b>保存路径</b>\n\n当前: <code>%s</code>\n\n"+
			"修改请发送: <code>/set_remote_folder /你的目录</code>", escapeHTMLText(current)),
		[][]tgclient.Button{{{Text: "📁 浏览文件", Data: "files_page_0"}}})
}

// can 问权限。Auth 为 nil 时一律放行 —— 与 dispatcher 装配 Dispatcher
// 的前提一致(没 Auth 就没有角色概念)。
func (a *App) can(ctx context.Context, userID string, action auth.Action) bool {
	if a.auth == nil {
		return true
	}
	ok, err := a.auth.Can(ctx, userID, action)
	if err != nil {
		a.log.Warn("权限判定失败", "userId", userID, "action", action, "err", err)
		return false
	}
	return ok
}

// canAdmin 问「这个动作是不是只有管理员能做」。
//
// 与 can 的区别只有一处,但那处是要害:can 在没装配 Auth 时放行(降级
// 模式下没有角色概念),而这里必须返回 false —— 没装配 Auth 就等于
// 没有一个人是管理员,不是「所有人都是管理员」。
// 少了这条,ownsTask 会把 can 的降级放行当成管理员授权,于是任何
// 人都能取消和重试别人的转存任务。
func (a *App) canAdmin(ctx context.Context, userID string, action auth.Action) bool {
	if a.auth == nil {
		return false
	}
	return a.can(ctx, userID, action)
}

// formatUptime 把时长写成 JS _getUptime 那样的「3h 5m 9s」。
func formatUptime(d time.Duration) string {
	total := int(d.Seconds())
	return fmt.Sprintf("%dh %dm %ds", total/3600, (total%3600)/60, total%60)
}
