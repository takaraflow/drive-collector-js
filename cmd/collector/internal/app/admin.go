package app

// 管理员看板 —— /task_queue、/users、/diagnosis 与开关服务模式。
//
// 对应 JS 侧 Dispatcher._handleTaskQueueCommand / _buildTaskQueueOverview /
// _handleTaskQueueCallback / _handleAdminUsersCommand / _buildAdminUsersView /
// _handleAdminUsersCallback / _handleDiagnosisCommand / _buildDiagnosisReport /
// _handleModeSwitchCommand,渲染对应 UIHelper.renderTaskQueue /
// renderTaskQueueDetail / renderAdminUsers / renderDiagnosisReport。
//
// 放 app 而不是 dispatcher 的理由与 /status 相同:重试失败任务要写状态机,
// 而 Dispatcher 的接口面只有「读权限 + 读任务」。
//
// 文案与 JS 侧 STRINGS.task_queue / admin_users / diagnosis / status 逐字
// 一致:切换期两边可能同时在跑,管理员看到的必须是同一句话。

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/d1"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"

	"github.com/redis/go-redis/v9"
)

const (
	// adminUserPageSize 是 /users 与任务详情页的每页条数 —— 与 JS 一致(8)。
	adminUserPageSize = 8
	// queueActiveLimit 是队列概览里的活跃任务条数 —— 与 JS 一致(10)。
	queueActiveLimit = 10
)

// 文案与 JS 侧 STRINGS 逐字一致。
const (
	adminNoPermission = "❌ <b>无权限</b>\n\n此操作仅限管理员执行。"

	tqLoading = "🔍 正在查询任务队列..."
	tqError   = "❌ <b>暂时无法查询任务队列</b>\n\n请重新加载；如果连续失败，请查看系统诊断。"
	tqNoAct   = "✅ 当前无活跃任务。请发送文件或链接来创建新任务。"

	auLoading = "🔍 正在查询用户列表..."
	auError   = "❌ <b>暂时无法查询用户列表</b>\n\n请重新加载；如果连续失败，请查看系统诊断。"
	auEmpty   = "当前没有可显示的用户。\n用户绑定网盘、提交任务或被设置角色后，会出现在这里。"

	diagLoading = "🔍 正在执行系统诊断..."
	diagError   = "❌ 诊断暂时无法完成，请稍后重试。"

	maintenanceMode = "🚧 <b>系统维护中</b>\n\n当前 Bot 仅限管理员使用，请稍后访问。"

	statusBtnUserList  = "👥 用户列表"
	statusBtnTaskQueue = "📊 全局队列"
	statusBtnDiagnosis = "🩺 系统诊断"
)

// tqStatusLabels 是队列里的状态名 —— 与 JS STRINGS.task_queue.status_labels。
var tqStatusLabels = map[contract.TaskStatus]string{
	contract.StatusQueued:      "🕒 排队中",
	contract.StatusDownloading: "⬇️ 下载中",
	contract.StatusDownloaded:  "📦 已下载",
	contract.StatusUploading:   "⬆️ 上传中",
	contract.StatusCompleted:   "✅ 已完成",
	contract.StatusFailed:      "❌ 失败",
	contract.StatusCancelled:   "🚫 已取消",
}

// tqStatusIcon 是状态按钮的图标 —— 与 JS _statusActionIcon 一致。
var tqStatusIcon = map[contract.TaskStatus]string{
	contract.StatusQueued:      "🕒",
	contract.StatusDownloading: "⬇️",
	contract.StatusDownloaded:  "📦",
	contract.StatusUploading:   "⬆️",
	contract.StatusCompleted:   "✅",
	contract.StatusFailed:      "❌",
	contract.StatusCancelled:   "🚫",
}

// tqOrderedStatuses 是概览里的展示顺序 —— 与 JS renderTaskQueue 一致。
var tqOrderedStatuses = []contract.TaskStatus{
	contract.StatusQueued, contract.StatusDownloading, contract.StatusUploading,
	contract.StatusCompleted, contract.StatusFailed, contract.StatusCancelled,
}

// ============================================================================
// /task_queue —— 全局队列
// ============================================================================

// handleTaskQueueCommand /task_queue —— 管理员看全局队列。
func (a *App) handleTaskQueueCommand(ctx context.Context, msg messageInfo) error {
	userID := fmt.Sprintf("%d", msg.SenderID)
	if !a.can(ctx, userID, auth.ActionSystemAdmin) {
		return a.tg.SendMessage(ctx, msg.ChatID, adminNoPermission)
	}
	if a.admin == nil {
		return a.tg.SendMessage(ctx, msg.ChatID, tqError)
	}
	// 先发占位再编辑 —— 与 JS 一致:管理员要看到「正在查」,
	// 否则 D1 慢一点他就以为命令没生效,再点一次。
	msgID, err := a.tg.SendMessageWithID(ctx, msg.ChatID, tqLoading)
	if err != nil {
		a.log.Error("/task_queue 占位消息发送失败", "err", err)
		return err
	}
	text, buttons, err := a.taskQueueView(ctx)
	if err != nil {
		a.log.Error("/task_queue 渲染失败", "err", err)
		return a.tg.EditMessage(ctx, msg.ChatID, msgID, tqError)
	}
	return a.tg.EditWithButtons(ctx, msg.ChatID, msgID, text, buttons)
}

// taskQueueView 渲染队列概览。
func (a *App) taskQueueView(ctx context.Context) (string, [][]tgclient.Button, error) {
	ov, err := a.admin.QueueOverview(ctx, queueActiveLimit)
	if err != nil {
		return "", nil, err
	}
	return renderQueueOverviewPanel(ov), queueOverviewButtons(ov.StatusCounts), nil
}

// openTaskQueue 把 /status 里的「全局队列」按钮画进当前消息。
func (a *App) openTaskQueue(ctx context.Context, cb tgclient.CallbackContext) error {
	if !a.can(ctx, fmt.Sprintf("%d", cb.UserID), auth.ActionSystemAdmin) {
		return a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, adminNoPermission)
	}
	if a.admin == nil {
		return a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, tqError)
	}
	text, buttons, err := a.taskQueueView(ctx)
	if err != nil {
		a.log.Error("/task_queue 渲染失败", "err", err)
		return a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, tqError)
	}
	return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, text, buttons)
}

// openAdminUsers 把 /status 里的「用户列表」按钮画进当前消息。
func (a *App) openAdminUsers(ctx context.Context, cb tgclient.CallbackContext) error {
	if !a.can(ctx, fmt.Sprintf("%d", cb.UserID), auth.ActionUserManage) {
		return a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, adminNoPermission)
	}
	if a.admin == nil {
		return a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, auError)
	}
	text, buttons, err := a.adminUsersView(ctx, "all", 0)
	if err != nil {
		a.log.Error("/users 渲染失败", "err", err)
		return a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, auError)
	}
	return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, text, buttons)
}

// handleTaskQueueCallback tq_* 那组按钮 —— 概览与状态详情。
func (a *App) handleTaskQueueCallback(ctx context.Context, cb tgclient.CallbackContext, data string) error {
	userID := fmt.Sprintf("%d", cb.UserID)
	answer := func(text string, alert bool) {
		if err := a.tg.AnswerCallback(ctx, cb.CallbackID, text, alert); err != nil {
			a.log.Warn("回应按钮失败", "err", err)
		}
	}

	if !a.can(ctx, userID, auth.ActionSystemAdmin) {
		answer(adminNoPermission, true)
		return nil
	}
	if a.admin == nil {
		answer("该功能暂不可用", true)
		return nil
	}

	// 「重试本页失败任务」要先于状态详情解析 —— retry_failed_page_1
	// 也会被后面的 tq 解析逻辑误当成状态名。
	if strings.HasPrefix(data, "retry_failed_page_") {
		return a.handleRetryFailedPage(ctx, cb, strings.TrimPrefix(data, "retry_failed_page_"))
	}

	if data == "tq_back" {
		text, buttons, err := a.taskQueueView(ctx)
		answer("", false)
		if err != nil {
			return a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, tqError)
		}
		return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, text, buttons)
	}

	// tq_{status}_{page} 与 tq_refresh_{status}_{page} 只有刷新语义差别,
	// 渲染结果一样 —— 刷新只是绕过缓存(这里本来就没缓存)。
	clean := data
	// 同 parseAdminUsersCallback:剥完要把 "tq_" 补回来。
	if strings.HasPrefix(data, "tq_refresh_") {
		clean = "tq_" + strings.TrimPrefix(data, "tq_refresh_")
	}
	parts := strings.Split(clean, "_")
	if len(parts) != 3 || parts[0] != "tq" {
		answer("该功能暂未迁移", false)
		return nil
	}
	status := contract.TaskStatus(parts[1])
	page, err := strconv.Atoi(parts[2])
	if err != nil || page < 0 {
		page = 0
	}
	if _, ok := tqStatusLabels[status]; !ok {
		answer("该功能暂未迁移", false)
		return nil
	}

	detail, err := a.admin.TasksByStatus(ctx, string(status), page, adminUserPageSize)
	answer("", false)
	if err != nil {
		a.log.Error("任务队列详情查询失败", "status", status, "err", err)
		return a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, tqError)
	}
	text, buttons := renderQueueDetailPanel(status, detail)
	return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, text, buttons)
}

// handleRetryFailedPage 重试当前页的失败任务 —— 与 JS retry_failed_page_* 一致。
//
// 确认流程要带着页码走:点了「重试本页」先换成「保留 / 确认重试」,
// 确认按钮的 data 里必须还带着同一个页码 —— 不带的话管理员在第 3 页
// 按确认,重试的却是第 0 页的任务。
func (a *App) handleRetryFailedPage(ctx context.Context, cb tgclient.CallbackContext, pageStr string) error {
	answer := func(text string, alert bool) {
		if err := a.tg.AnswerCallback(ctx, cb.CallbackID, text, alert); err != nil {
			a.log.Warn("回应按钮失败", "err", err)
		}
	}
	confirming := strings.HasPrefix(pageStr, "confirm_")
	if confirming {
		pageStr = strings.TrimPrefix(pageStr, "confirm_")
	}

	page, err := strconv.Atoi(pageStr)
	if err != nil || page < 0 {
		answer(statusTaskNotFound, true)
		return nil
	}

	detail, err := a.admin.TasksByStatus(ctx, string(contract.StatusFailed), page, adminUserPageSize)
	if err != nil {
		a.log.Error("查询失败任务失败", "page", page, "err", err)
		answer(statusTaskNotFound, true)
		return nil
	}
	// 一条都没有就别装出「确认重试」—— 那按钮点了必然无事发生。
	if len(detail.Tasks) == 0 {
		answer(statusTaskNotFound, true)
		return nil
	}

	if confirming {
		n := 0
		for _, t := range detail.Tasks {
			if a.retryTask(ctx, fmt.Sprintf("%d", cb.UserID), t.ID) == statusCmdSent {
				n++
			}
		}
		if n == 0 {
			answer(statusTaskNotFound, true)
			return nil
		}
		a.log.Info("批量重试失败任务", "page", page, "count", n, "by", cb.UserID)
		answer(fmt.Sprintf("已重新排队 %d 个任务", n), false)
		return nil
	}

	answer("", false)
	return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, statusRetryConfirm,
		[][]tgclient.Button{
			{{Text: "保留任务", Data: "tq_back"}},
			{{Text: "确认重试", Data: fmt.Sprintf("retry_failed_page_confirm_%d", page)}},
		})
}

// renderQueueOverviewPanel 队列概览正文 —— 与 JS renderTaskQueue 的 html 一致。
func renderQueueOverviewPanel(ov store.QueueOverview) string {
	var b strings.Builder
	b.WriteString("📊 <b>全局任务队列</b>\n━━━━━━━━━━━━━━━━━━━\n\n")
	b.WriteString("📈 <b>状态分布</b>\n")
	for _, s := range tqOrderedStatuses {
		count := ov.StatusCounts[string(s)]
		// 活跃状态恒显示(哪怕是 0),历史状态只在非零时显示 ——
		// 一排「已完成 0 / 已取消 0」没人要看。
		if count > 0 || s == contract.StatusQueued || s == contract.StatusDownloading || s == contract.StatusUploading {
			fmt.Fprintf(&b, "<code>%s: %d</code>\n", tqStatusLabels[s], count)
		}
	}
	b.WriteString("\n")

	if len(ov.ActiveTasks) == 0 {
		b.WriteString(tqNoAct + "\n")
	} else {
		fmt.Fprintf(&b, "⚡ <b>活跃任务</b> (最近 %d 条)\n", len(ov.ActiveTasks))
		for i, t := range ov.ActiveTasks {
			fmt.Fprintf(&b, "<code>%d.</code> %s <code>%s</code> | 👤 <code>%s</code> | %s\n",
				i+1, tqIconOf(t.Status), escapeHTMLText(shortenRunes(taskName(t), 25)),
				escapeHTMLText(t.UserID), relativeTime(t.UpdatedAt))
		}
	}
	b.WriteString("\n")

	if len(ov.UserCounts) > 0 {
		b.WriteString("👥 <b>用户活跃分布</b> (Top 5)\n")
		for i, u := range ov.UserCounts {
			fmt.Fprintf(&b, "<code>%d.</code> 👤 <code>%s</code> — %d 个任务\n",
				i+1, escapeHTMLText(u.UserID), u.Count)
		}
	}
	b.WriteString("━━━━━━━━━━━━━━━━━━━")
	return b.String()
}

// queueOverviewButtons 状态筛选按钮 —— 与 JS renderTaskQueue 一致。
func queueOverviewButtons(counts map[string]int) [][]tgclient.Button {
	active := []contract.TaskStatus{contract.StatusQueued, contract.StatusDownloading, contract.StatusUploading}
	others := []contract.TaskStatus{contract.StatusCompleted, contract.StatusFailed, contract.StatusCancelled}

	row1 := make([]tgclient.Button, 0, len(active))
	for _, s := range active {
		row1 = append(row1, tgclient.Button{
			Text: fmt.Sprintf("%s %s(%d)", tqStatusIcon[s], tqShortLabel(s), counts[string(s)]),
			Data: fmt.Sprintf("tq_%s_0", s),
		})
	}
	row2 := []tgclient.Button{}
	for _, s := range others {
		if counts[string(s)] > 0 {
			row2 = append(row2, tgclient.Button{
				Text: fmt.Sprintf("%s %s(%d)", tqStatusIcon[s], tqShortLabel(s), counts[string(s)]),
				Data: fmt.Sprintf("tq_%s_0", s),
			})
		}
	}
	if len(row2) == 0 {
		return [][]tgclient.Button{row1}
	}
	return [][]tgclient.Button{row1, row2}
}

// renderQueueDetailPanel 某状态的任务详情 —— 与 JS renderTaskQueueDetail 一致。
func renderQueueDetailPanel(status contract.TaskStatus, d store.TasksByStatus) (string, [][]tgclient.Button) {
	label := tqStatusLabels[status]
	var b strings.Builder
	fmt.Fprintf(&b, "📊 任务队列 — %s (共 %d 条)\n━━━━━━━━━━━━━━━━━━━\n", label, d.Total)

	if len(d.Tasks) == 0 {
		b.WriteString("📭 该状态下暂无任务。您可以发送文件或链接来创建新任务。\n")
	} else {
		for i, t := range d.Tasks {
			fmt.Fprintf(&b, "<code>%d.</code> %s <code>%s</code> | 👤 <code>%s</code> | %s\n",
				d.Page*d.PageSize+i+1, tqStatusIcon[status],
				escapeHTMLText(shortenRunes(taskName(t), 25)),
				escapeHTMLText(t.UserID), relativeTime(t.UpdatedAt))
			// 失败原因与文件大小是排查「为什么失败」的第一手线索。
			if status == contract.StatusFailed && t.ErrorMsg.Valid && t.ErrorMsg.String != "" {
				b.WriteString("   ⚠️ " + escapeHTMLText(truncateRunes(t.ErrorMsg.String, 50)) + "\n")
			}
			if t.FileSize > 0 {
				fmt.Fprintf(&b, "   📦 %s\n", formatSize(t.FileSize))
			}
		}
	}
	b.WriteString("━━━━━━━━━━━━━━━━━━━\n")
	fmt.Fprintf(&b, "第 %d/%d 页 | 共 %d 条", d.Page+1, d.TotalPages, d.Total)

	nav := paginationRow(
		d.Page, d.TotalPages,
		fmt.Sprintf("tq_refresh_%s_%d", status, d.Page),
		func(p int) string { return fmt.Sprintf("tq_%s_%d", status, p) },
	)
	back := []tgclient.Button{{Text: "↩️ 返回", Data: "tq_back"}}

	buttons := [][]tgclient.Button{back}
	// 只有失败页才给「重试本页」—— 在别的状态上按它毫无意义。
	if status == contract.StatusFailed && len(d.Tasks) > 0 {
		buttons = append(buttons, []tgclient.Button{
			{Text: "🔄 重试本页失败任务", Data: fmt.Sprintf("retry_failed_page_%d", d.Page)},
		})
	}
	return b.String(), append(buttons, nav)
}

// ============================================================================
// /users —— 管理员用户列表
// ============================================================================

// handleAdminUsersCommand /users —— 管理员看用户列表。
func (a *App) handleAdminUsersCommand(ctx context.Context, msg messageInfo) error {
	userID := fmt.Sprintf("%d", msg.SenderID)
	if !a.can(ctx, userID, auth.ActionUserManage) {
		return a.tg.SendMessage(ctx, msg.ChatID, adminNoPermission)
	}
	if a.admin == nil {
		return a.tg.SendMessage(ctx, msg.ChatID, auError)
	}
	msgID, err := a.tg.SendMessageWithID(ctx, msg.ChatID, auLoading)
	if err != nil {
		a.log.Error("/users 占位消息发送失败", "err", err)
		return err
	}
	text, buttons, err := a.adminUsersView(ctx, "all", 0)
	if err != nil {
		a.log.Error("/users 渲染失败", "err", err)
		return a.tg.EditMessage(ctx, msg.ChatID, msgID, auError)
	}
	return a.tg.EditWithButtons(ctx, msg.ChatID, msgID, text, buttons)
}

// adminUsersView 取一页用户并渲染。
func (a *App) adminUsersView(ctx context.Context, filter string, page int) (string, [][]tgclient.Button, error) {
	data, err := a.admin.ListUsersForAdmin(ctx, filter, page, adminUserPageSize, a.ownerID)
	if err != nil {
		return "", nil, err
	}
	return renderAdminUsersPanel(data), adminUsersButtons(data), nil
}

// handleAdminUsersCallback au_* 那组按钮 —— 筛选与翻页。
func (a *App) handleAdminUsersCallback(ctx context.Context, cb tgclient.CallbackContext, data string) error {
	userID := fmt.Sprintf("%d", cb.UserID)
	answer := func(text string, alert bool) {
		if err := a.tg.AnswerCallback(ctx, cb.CallbackID, text, alert); err != nil {
			a.log.Warn("回应按钮失败", "err", err)
		}
	}

	if !a.can(ctx, userID, auth.ActionUserManage) {
		answer(adminNoPermission, true)
		return nil
	}
	if a.admin == nil {
		answer("该功能暂不可用", true)
		return nil
	}

	if data == "admin_users_back" {
		answer("已返回", false)
		return a.redrawStatus(ctx, cb)
	}

	filter, page, ok := parseAdminUsersCallback(data)
	if !ok {
		answer("该功能暂未迁移", false)
		return nil
	}
	text, buttons, err := a.adminUsersView(ctx, filter, page)
	answer("", false)
	if err != nil {
		a.log.Error("/users 渲染失败", "filter", filter, "err", err)
		return a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, auError)
	}
	return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID, text, buttons)
}

// parseAdminUsersCallback 解析 au_{filter}_{page} 与 au_refresh_{filter}_{page}。
func parseAdminUsersCallback(data string) (filter string, page int, ok bool) {
	clean := data
	// 只在真是刷新按钮时才剥前缀,而且剥完要把 "au_" 补回来 ——
	// 剥 "au_refresh_" 会把前缀里的 "au_" 一起吃掉,剩下
	// "banned_2" 拆成两段,永远解析不出来。
	if strings.HasPrefix(data, "au_refresh_") {
		clean = "au_" + strings.TrimPrefix(data, "au_refresh_")
	}
	parts := strings.Split(clean, "_")
	if len(parts) < 3 || parts[0] != "au" {
		return "", 0, false
	}
	filter = strings.Join(parts[1:len(parts)-1], "_")
	n, err := strconv.Atoi(parts[len(parts)-1])
	if err != nil || n < 0 {
		n = 0
	}
	return store.NormalizeAdminFilter(filter), n, true
}

// renderAdminUsersPanel 用户列表正文 —— 与 JS renderAdminUsers 一致。
func renderAdminUsersPanel(data store.AdminUsersPage) string {
	filters := map[string]string{
		"all": "全部", "active": "活跃", "admin": "管理",
		"banned": "封禁", "nodrive": "未绑盘",
	}
	roles := map[string]string{
		"owner": "所有者", "admin": "管理员", "trusted": "可信用户",
		"user": "普通用户", "banned": "已封禁",
	}

	var b strings.Builder
	b.WriteString("👥 <b>用户列表</b>\n")
	fmt.Fprintf(&b, "共 %d 位用户 · 活跃 %d · 管理 %d · 封禁 %d\n",
		data.Summary.Total, data.Summary.Active, data.Summary.Admins, data.Summary.Banned)
	fmt.Fprintf(&b, "筛选: %s · 第 %d/%d 页\n", filters[data.Filter], data.Page+1, data.TotalPages)
	b.WriteString("━━━━━━━━━━━━━━━━━━━\n")

	if len(data.Users) == 0 {
		b.WriteString(auEmpty + "\n")
	}
	for i, u := range data.Users {
		role := u.Role
		if role == "" {
			role = "user"
		}
		fmt.Fprintf(&b, "<code>%d.</code> %s <code>%s</code> · %s\n",
			data.Page*data.PageSize+i+1, adminUserRoleIcon(role),
			escapeHTMLText(u.UserID), roles[role])
		fmt.Fprintf(&b, "   网盘 %d · 任务 %d · 活跃 %d · 最近 %s\n",
			u.Drives, u.Tasks, u.Active, adminUserLastSeen(u.LastSeenAt))
		fmt.Fprintf(&b, "   完成 %d · 失败 %d\n", u.Complete, u.Failed)
	}
	b.WriteString("━━━━━━━━━━━━━━━━━━━")
	return b.String()
}

// adminUsersButtons 筛选行 + 翻页行 —— 与 JS renderAdminUsers 一致。
func adminUsersButtons(data store.AdminUsersPage) [][]tgclient.Button {
	f := data.Filter
	active := func(label string, on bool) string {
		if on {
			return "✓ " + label
		}
		return label
	}

	filterRow := []tgclient.Button{
		{Text: active("全部", f == "all"), Data: "au_all_0"},
		{Text: active("活跃", f == "active"), Data: "au_active_0"},
		{Text: active("管理", f == "admin"), Data: "au_admin_0"},
	}
	secondRow := []tgclient.Button{
		{Text: active("封禁", f == "banned"), Data: "au_banned_0"},
		{Text: active("未绑盘", f == "nodrive"), Data: "au_nodrive_0"},
	}
	nav := paginationRow(
		data.Page, data.TotalPages,
		fmt.Sprintf("au_refresh_%s_%d", f, data.Page),
		func(p int) string { return fmt.Sprintf("au_%s_%d", f, p) },
	)
	back := []tgclient.Button{{Text: "↩️ 返回", Data: "admin_users_back"}}

	return [][]tgclient.Button{filterRow, secondRow, nav, back}
}

// adminUserRoleIcon 角色图标 —— 与 JS _adminUserRoleIcon 一致。
func adminUserRoleIcon(role string) string {
	switch role {
	case "owner":
		return "👑"
	case "admin":
		return "🛡️"
	case "trusted":
		return "⭐"
	case "banned":
		return "🚫"
	default:
		return "👤"
	}
}

// adminUserLastSeen 无记录时给「无记录」—— 与 JS _formatAdminUserLastSeen 一致。
func adminUserLastSeen(ts int64) string {
	if ts == 0 {
		return "无记录"
	}
	return relativeTime(ts)
}

// ============================================================================
// /diagnosis —— 系统诊断
// ============================================================================

// handleDiagnosisCommand /diagnosis —— 管理员跑一次体检。
func (a *App) handleDiagnosisCommand(ctx context.Context, msg messageInfo) error {
	userID := fmt.Sprintf("%d", msg.SenderID)
	if !a.can(ctx, userID, auth.ActionMaintenanceBypass) {
		return a.tg.SendMessage(ctx, msg.ChatID, adminNoPermission)
	}
	msgID, err := a.tg.SendMessageWithID(ctx, msg.ChatID, diagLoading)
	if err != nil {
		a.log.Error("/diagnosis 占位消息发送失败", "err", err)
		return err
	}
	return a.editDiagnosisReport(ctx, msg.ChatID, msgID)
}

// editDiagnosisReport 重画诊断报告 —— 按钮回调与首次执行共用。
func (a *App) editDiagnosisReport(ctx context.Context, chatID int64, msgID int) error {
	text := a.diagnosisReport(ctx)
	return a.tg.EditWithButtons(ctx, chatID, msgID, text, [][]tgclient.Button{
		{{Text: "🔄 重新诊断", Data: "diagnosis_run"}},
		{{Text: "📊 全局队列", Data: "task_queue_open"}},
	})
}

// diagnosisReport 组装诊断正文 —— 与 JS renderDiagnosisReport 一致。
//
// 每一项都是真的探一次:Redis 真的 ping、D1 真的 SELECT 1。
// 编一个「✅ 正常」出来比不显示更害人 —— 管理员会因此以为服务是好的。
func (a *App) diagnosisReport(ctx context.Context) string {
	var b strings.Builder
	b.WriteString("🔍 <b>系统诊断报告</b>\n━━━━━━━━━━━━━━━━━━━\n\n")

	b.WriteString("🏗️ <b>多实例状态</b>\n")
	if a.cfg.Coord == nil {
		b.WriteString("<code>数据获取失败</code>\n")
	} else {
		id := a.cfg.Coord.ID()
		if id == "" {
			id = "unknown"
		}
		leaderBadge := ""
		if held, err := a.cfg.Coord.HasTelegramLock(ctx); err == nil && held {
			leaderBadge = " (👑)"
		}
		fmt.Fprintf(&b, "<code>ID:   %s%s</code>\n", escapeHTMLText(id), leaderBadge)

		tgState := "❌ 已断开"
		if a.tg != nil && a.tg.SelfID() != 0 {
			tgState = "✅ 已连接"
		}
		lockHolder := "否"
		if held, err := a.cfg.Coord.HasTelegramLock(ctx); err == nil && held {
			lockHolder = "是"
		}
		fmt.Fprintf(&b, "<code>TG:   %s | 🔒 %s</code>\n", tgState, lockHolder)

		instances, err := a.cfg.Coord.ActiveInstances(ctx)
		if err != nil {
			fmt.Fprintf(&b, "<code>活跃: 查询失败(%s)</code>\n", escapeHTMLText(err.Error()))
		} else {
			fmt.Fprintf(&b, "<code>活跃: %d 个实例</code>\n", len(instances))
		}
		if v := appVersion(); v != "" {
			fmt.Fprintf(&b, "<code>版本: %s</code>\n", escapeHTMLText(v))
		}
	}
	b.WriteString("\n")

	b.WriteString("🌐 <b>网络诊断</b>\n")
	checks := []diagCheck{
		telegramCheck(a.tg),
		d1Check(ctx, a.d1c),
		redisCheck(ctx, a.cfg.Redis),
		rcloneCheck(ctx, a.rcloneRunner),
	}
	errors := 0
	for _, c := range checks {
		if c.emoji == "❌" {
			errors++
		}
		fmt.Fprintf(&b, "<code>%-7s: %s %s (%s)</code>\n",
			c.label, c.emoji, escapeHTMLText(c.msg), c.rt)
	}
	b.WriteString("\n")

	b.WriteString("💾 <b>系统资源</b>\n")
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	fmt.Fprintf(&b, "<code>内存: %s</code>\n", formatSize(int64(ms.Sys)))
	fmt.Fprintf(&b, "<code>Go堆: %s</code>\n", formatSize(int64(ms.HeapAlloc)))
	fmt.Fprintf(&b, "<code>运行: %s</code>\n", formatUptime(time.Since(startedAt)))
	b.WriteString("━━━━━━━━━━━━━━━━━━━\n")

	if errors > 0 {
		fmt.Fprintf(&b, "⚠️ 发现 %d 个服务异常，请检查网络连接或配置。", errors)
	} else {
		b.WriteString("✅ 所有服务运行正常")
	}
	return b.String()
}

// 诊断项 —— label/emoji/msg/rt 四个字段就是渲染要的全部。
type diagCheck struct {
	label string
	emoji string
	msg   string
	rt    string
}

// telegramCheck 探 Telegram —— 已连上就是通,没连上就是断。
func telegramCheck(tg Telegram) diagCheck {
	if tg == nil || tg.SelfID() == 0 {
		return diagCheck{"TG-MT", "❌", "Telegram MTProto API 连接失败", "N/A"}
	}
	return diagCheck{"TG-MT", "✅", "Telegram MTProto API 连接正常", "N/A"}
}

// d1Check 真的跑一条 SELECT 1 —— D1 是每次上传都要用的依赖。
func d1Check(ctx context.Context, db *d1.Client) diagCheck {
	if db == nil {
		return diagCheck{"DB-D1", "❓", "D1 未配置", "N/A"}
	}
	start := time.Now()
	if err := db.Ping(ctx); err != nil {
		return diagCheck{"DB-D1", "❌", "Cloudflare D1 连接失败: " + err.Error(),
			time.Since(start).String()}
	}
	return diagCheck{"DB-D1", "✅", "Cloudflare D1 连接正常", time.Since(start).String()}
}

// redisCheck 真的 PING —— Redis 挂了媒体组缓冲与实例锁都会哑掉。
func redisCheck(ctx context.Context, rdb *redis.Client) diagCheck {
	if rdb == nil {
		return diagCheck{"REDIS", "❓", "Redis 未配置", "N/A"}
	}
	start := time.Now()
	if err := rdb.Ping(ctx).Err(); err != nil {
		return diagCheck{"REDIS", "❌", "Redis 连接失败: " + err.Error(),
			time.Since(start).String()}
	}
	return diagCheck{"REDIS", "✅", "Redis 连接正常", time.Since(start).String()}
}

// rcloneCheck 跑一次 rclone version —— 转存全靠它。
func rcloneCheck(ctx context.Context, runner *rclone.Runner) diagCheck {
	if runner == nil {
		return diagCheck{"RCLONE", "❓", "rclone 未配置", "N/A"}
	}
	start := time.Now()
	out, err := runner.Version(ctx)
	if err != nil {
		return diagCheck{"RCLONE", "❌", "rclone 不可用: " + err.Error(),
			time.Since(start).String()}
	}
	return diagCheck{"RCLONE", "✅", "rclone 可用: " + out, time.Since(start).String()}
}

// appVersion 取构建版本;没注入时留空而不是编一个。
func appVersion() string { return os.Getenv("APP_VERSION") }

// ============================================================================
// 开关服务模式 —— /open_service /close_service /status_public /status_private
// ============================================================================

// handleModeSwitchCommand 切公开 / 维护模式 —— 与 JS _handleModeSwitchCommand 一致。
//
// 先确认再执行:这个开关一按下去,所有普通用户立刻被挡在门外,
// 误按的代价是全站不可用。所以按钮流程是强制的,不走「一条命令直接生效」。
func (a *App) handleModeSwitchCommand(ctx context.Context, msg messageInfo, mode string) error {
	userID := fmt.Sprintf("%d", msg.SenderID)
	if !a.can(ctx, userID, auth.ActionMaintenanceBypass) {
		return a.tg.SendMessage(ctx, msg.ChatID, adminNoPermission)
	}
	mode = store.NormalizeAccessMode(mode)
	label, target := "开启公开访问", "服务访问模式"
	if mode == store.AccessModePrivate {
		label, target = "进入维护模式", "服务访问模式"
	}
	return a.tg.SendWithButtons(ctx, msg.ChatID,
		fmt.Sprintf("⚠️ <b>确认执行此管理操作？</b>\n\n操作: <code>%s</code>\n目标: <code>%s</code>",
			escapeHTMLText(label), escapeHTMLText(target)),
		[][]tgclient.Button{
			{{Text: "取消", Data: "mode_switch_cancel_" + mode}},
			{{Text: "确认执行", Data: "mode_switch_execute_" + mode}},
		})
}

// handleModeSwitchCallback 确认 / 取消切换。
func (a *App) handleModeSwitchCallback(ctx context.Context, cb tgclient.CallbackContext, data string) error {
	userID := fmt.Sprintf("%d", cb.UserID)
	answer := func(text string, alert bool) {
		if err := a.tg.AnswerCallback(ctx, cb.CallbackID, text, alert); err != nil {
			a.log.Warn("回应按钮失败", "err", err)
		}
	}
	if !a.can(ctx, userID, auth.ActionMaintenanceBypass) {
		answer(adminNoPermission, true)
		return nil
	}
	if a.admin == nil {
		answer("该功能暂不可用", true)
		return nil
	}

	if strings.HasPrefix(data, "mode_switch_cancel_") {
		answer("已取消操作", false)
		return a.redrawStatus(ctx, cb)
	}
	if !strings.HasPrefix(data, "mode_switch_execute_") {
		return nil
	}

	// 执行前再验一次权限:确认按钮是用户可控的回调数据,
	// 权限在按下按钮那一刻可能已经没了(比如刚被降级)。
	mode := store.NormalizeAccessMode(strings.TrimPrefix(data, "mode_switch_execute_"))
	if err := a.admin.SetSetting(ctx, store.AccessModeKey, mode); err != nil {
		a.log.Error("切换访问模式失败", "mode", mode, "err", err)
		answer("❌ <b>管理操作未完成</b>", true)
		return nil
	}
	a.invalidateAccessModeCache()
	label := "公开"
	if mode == store.AccessModePrivate {
		label = "私有(维护)"
	}
	a.log.Info("访问模式已切换", "mode", mode, "by", userID)
	answer("✅ 访问模式已切换", false)
	return a.tg.EditWithButtons(ctx, cb.ChatID, cb.MsgID,
		fmt.Sprintf("✅ <b>访问模式已切换</b>\n\n当前模式: <code>%s</code>", escapeHTMLText(label)),
		[][]tgclient.Button{{{Text: "📊 我的状态", Data: "status_general"}}})
}

// senderOf 从 update 里取出「谁发的 / 回哪 / 要回应哪个 callback」。
//
// isCallback 分开返回而不是靠 msgID 是否为 0 判断:普通消息也有非 0 的
// 消息 id,拿它当 callback id 回应会回错目标 —— 表现为「点了没反应」。
func senderOf(u tgclient.Update) (userID string, chatID int64, callbackID int64, isCallback bool) {
	if cb, ok := tgclient.CallbackOf(u); ok {
		return fmt.Sprintf("%d", cb.UserID), cb.ChatID, cb.CallbackID, true
	}
	if msg, ok := messageOf(u); ok {
		return fmt.Sprintf("%d", msg.SenderID), msg.ChatID, 0, false
	}
	return "", 0, 0, false
}

// accessMode 读当前访问模式 —— 全局守卫用。
//
// 带一层短 TTL 的进程内缓存:全局守卫每条消息都要问一次,
// 而每条消息一次 D1 HTTP 往返,在正常流量下就是「为了挡维护模式
// 把 D1 打满」。5 秒的窗口足够短 —— 管理员切完模式最多等 5 秒生效,
// 换来的是稳态下零外部调用。
func (a *App) accessMode(ctx context.Context) string {
	a.modeMu.Lock()
	if a.modeCached != "" && time.Since(a.modeCachedAt) < accessModeCacheTTL {
		mode := a.modeCached
		a.modeMu.Unlock()
		return mode
	}
	a.modeMu.Unlock()

	mode := store.AccessModePublic
	if a.admin != nil {
		v, err := a.admin.GetSetting(ctx, store.AccessModeKey, store.AccessModePublic)
		if err != nil {
			a.log.Error("读访问模式失败,按公开处理", "err", err)
		} else {
			mode = store.NormalizeAccessMode(v)
		}
	}

	a.modeMu.Lock()
	a.modeCached, a.modeCachedAt = mode, time.Now()
	a.modeMu.Unlock()
	return mode
}

// accessModeCacheTTL 是访问模式的进程内缓存窗口。
const accessModeCacheTTL = 5 * time.Second

// invalidateAccessModeCache 在切换模式后立刻清缓存 —— 不清的话
// 管理员按下「进入维护模式」后会有最多 5 秒的窗口,普通用户还能照常用。
func (a *App) invalidateAccessModeCache() {
	a.modeMu.Lock()
	a.modeCached, a.modeCachedAt = "", time.Time{}
	a.modeMu.Unlock()
}

// globalGuard 黑名单 + 维护模式的全局拦截。
//
// 返回 done=true 表示这条 update 已经处理完(被拒),调用方不要再分流。
func (a *App) globalGuard(ctx context.Context, u tgclient.Update) (bool, error) {
	userID, chatID, callbackID, isCallback := senderOf(u)
	if userID == "" {
		return false, nil
	}

	// 1. 黑名单。owner 也不豁免 —— 与 JS 侧一致:
	// 账号被盗后的紧急风控,不能因为「他刚好是 owner」就失效。
	if a.auth != nil {
		banned, err := a.auth.IsBanned(ctx, userID)
		if err != nil {
			a.log.Error("查封禁状态失败,放行", "userId", userID, "err", err)
		} else if banned {
			a.log.Info("封禁用户的消息被忽略", "userId", userID)
			// 封禁用户必须收到回应,否则客户端一直转圈。
			if isCallback {
				a.tg.AnswerCallback(ctx, callbackID, "", false)
			}
			return true, nil
		}
	}

	// 2. 维护模式:只放行管理员。
	if !a.blockedByMaintenance(ctx, userID) {
		return false, nil
	}
	if isCallback {
		a.tg.AnswerCallback(ctx, callbackID, "🚧 系统维护中", true)
		return true, nil
	}
	return true, a.tg.SendMessage(ctx, chatID, maintenanceMode)
}

// blockedByMaintenance 非管理员在维护模式下是否该被拦。
//
// 读设置失败时返回 false(放行):把「D1 抖了一下」变成「所有用户
// 都用不了机器人」,代价远大于放行。JS 侧 get 的默认值也是 public。
func (a *App) blockedByMaintenance(ctx context.Context, userID string) bool {
	return maintenanceBlocks(a.accessMode(ctx), a.can(ctx, userID, auth.ActionMaintenanceBypass))
}

// maintenanceBlocks 是上面那条判定的纯函数部分 ——
// 单独拎出来是为了能直接测「维护模式 + 非管理员 = 拦」这个组合。
func maintenanceBlocks(mode string, isAdmin bool) bool {
	return mode == store.AccessModePrivate && !isAdmin
}

// ============================================================================
// 共享的小工具
// ============================================================================

// tqIconOf 状态图标;未知状态给「•」而不是空串 —— 与 JS 一致。
func tqIconOf(s contract.TaskStatus) string {
	if v, ok := tqStatusIcon[s]; ok {
		return v
	}
	return "•"
}

// tqShortLabel 按钮上的短名(去掉图标)。
func tqShortLabel(s contract.TaskStatus) string {
	label := tqStatusLabels[s]
	if _, rest, ok := strings.Cut(label, " "); ok {
		return rest
	}
	return label
}

// taskName 任务文件名;空则给「-」—— 与 JS 的 `t.file_name || '-'` 一致。
func taskName(t store.Task) string {
	if t.FileName.Valid && t.FileName.String != "" {
		return t.FileName.String
	}
	return "-"
}

// paginationRow 翻页行 —— 与 JS _buildPaginationRow 布局一致。
func paginationRow(page, totalPages int, refreshData string, pageData func(int) string) []tgclient.Button {
	if totalPages < 1 {
		totalPages = 1
	}
	last := totalPages - 1
	row := []tgclient.Button{}
	if page > 0 {
		row = append(row,
			tgclient.Button{Text: "⏮️ 首页", Data: pageData(0)},
			tgclient.Button{Text: "⬅️ 上一页", Data: pageData(page - 1)},
		)
	}
	row = append(row, tgclient.Button{Text: "🔄 刷新", Data: refreshData})
	if page < last {
		row = append(row,
			tgclient.Button{Text: "➡️ 下一页", Data: pageData(page + 1)},
			tgclient.Button{Text: "⏭️ 末页", Data: pageData(last)},
		)
	}
	return row
}

// relativeTime 毫秒时间戳 → 「刚刚 / 5分钟前」—— 与 JS _formatRelativeTime 一致。
func relativeTime(ts int64) string {
	if ts == 0 {
		return "-"
	}
	d := time.Since(time.UnixMilli(ts))
	if d < time.Minute {
		return "刚刚"
	}
	if d < time.Hour {
		return fmt.Sprintf("%d分钟前", int(d.Minutes()))
	}
	if d < 24*time.Hour {
		return fmt.Sprintf("%d小时前", int(d.Hours()))
	}
	return fmt.Sprintf("%d天前", int(d.Hours()/24))
}

// truncateRunes 超长截断(加省略号)—— 与 JS 的 substring + '...' 一致。
func truncateRunes(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "..."
}
