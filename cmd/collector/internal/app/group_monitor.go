package app

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

type groupThrottle struct {
	mu       sync.Mutex
	lastEdit map[int64]time.Time
	timers   map[int64]*time.Timer
}

var gMonitorThrottle = &groupThrottle{
	lastEdit: make(map[int64]time.Time),
	timers:   make(map[int64]*time.Timer),
}

// renderProgressBar 渲染控制字符等宽进度条
func renderProgressBar(ratio float64, width int) string {
	if ratio < 0 {
		ratio = 0
	} else if ratio > 1 {
		ratio = 1
	}
	filled := int(ratio * float64(width))
	if filled < 0 {
		filled = 0
	}
	if filled > width {
		filled = width
	}
	pct := int(ratio * 100)
	return fmt.Sprintf("<code>[%s%s]</code> %d%%", strings.Repeat("█", filled), strings.Repeat("░", width-filled), pct)
}

// renderTaskLines 格式化媒体组任务条目，在项目 > 10 时提供智能折叠保护
func renderTaskLines(tasks []store.Task, focusTask *store.Task, focusStatus string, focusErr error) []string {
	totalCount := len(tasks)
	formatItem := func(t store.Task) string {
		isFocus := focusTask != nil && t.ID == focusTask.ID
		st := string(t.Status)
		if isFocus && focusStatus != "" {
			st = focusStatus
		}

		name := t.FileName.String
		if name == "" {
			name = "未知文件"
		}
		dispName := shortenFileName(name, 22)
		dispName = escapeHTMLText(dispName)

		var icon, statusText string
		switch st {
		case string(contract.StatusCompleted):
			icon = "✅"
			statusText = "完成"
		case string(contract.StatusFailed):
			icon = "❌"
			errStr := ""
			if isFocus && focusErr != nil {
				errStr = noticeReason(focusErr)
			} else if t.ErrorMsg.Valid && t.ErrorMsg.String != "" {
				errStr = noticeReason(errors.New(t.ErrorMsg.String))
			}
			if errStr != "" {
				r := []rune(errStr)
				if len(r) > 16 {
					errStr = string(r[:16]) + "…"
				}
				statusText = fmt.Sprintf("失败: %s", escapeHTMLText(errStr))
			} else {
				statusText = "失败"
			}
		case string(contract.StatusCancelled):
			icon = "🚫"
			statusText = "已取消"
		case string(contract.StatusDownloading):
			icon = "🔄"
			statusText = "下载中"
		case string(contract.StatusUploading):
			icon = "🔄"
			statusText = "转存中"
		default: // queued or empty
			icon = "🕒"
			statusText = "等待中"
		}
		return fmt.Sprintf("%s %s (%s)", icon, dispName, statusText)
	}

	// 10 个以内全量展示
	if totalCount <= 10 {
		lines := make([]string, 0, totalCount)
		for _, t := range tasks {
			lines = append(lines, formatItem(t))
		}
		return lines
	}

	// 超过 10 个条目：折叠已完成项，重点展示正在进行和失败的项目
	var completedItems []store.Task
	var attentionItems []store.Task
	var queuedItems []store.Task

	for _, t := range tasks {
		isFocus := focusTask != nil && t.ID == focusTask.ID
		st := string(t.Status)
		if isFocus && focusStatus != "" {
			st = focusStatus
		}
		switch st {
		case string(contract.StatusCompleted):
			completedItems = append(completedItems, t)
		case string(contract.StatusDownloading), string(contract.StatusUploading), string(contract.StatusFailed):
			attentionItems = append(attentionItems, t)
		default:
			queuedItems = append(queuedItems, t)
		}
	}

	lines := make([]string, 0, 10)
	if len(completedItems) > 0 {
		if len(attentionItems) == 0 && len(queuedItems) == 0 {
			// 全部已完成：展示前 3 个和后 2 个
			for i := 0; i < 3 && i < len(completedItems); i++ {
				lines = append(lines, formatItem(completedItems[i]))
			}
			if len(completedItems) > 5 {
				lines = append(lines, fmt.Sprintf("… (折叠其余 %d 个已完成文件) …", len(completedItems)-5))
				for i := len(completedItems) - 2; i < len(completedItems); i++ {
					lines = append(lines, formatItem(completedItems[i]))
				}
			}
			return lines
		}
		lines = append(lines, fmt.Sprintf("✅ 已完成 %d 个文件 (已折叠)", len(completedItems)))
	}

	for _, t := range attentionItems {
		lines = append(lines, formatItem(t))
	}

	maxQueued := 5
	if len(attentionItems) > 4 {
		maxQueued = 2
	}
	for i := 0; i < len(queuedItems) && i < maxQueued; i++ {
		lines = append(lines, formatItem(queuedItems[i]))
	}
	if len(queuedItems) > maxQueued {
		lines = append(lines, fmt.Sprintf("🕒 其余 %d 个文件等待排队中…", len(queuedItems)-maxQueued))
	}

	return lines
}

// renderGroupMonitor 渲染媒体组聚合转存看板
func renderGroupMonitor(tasks []store.Task, focusTask *store.Task, focusStatus string, folder string, focusErr error) (string, [][]tgclient.Button) {
	totalCount := len(tasks)
	if totalCount == 0 {
		return "📊 <b>媒体组转存看板</b>\n━━━━━━━━━━━━━━\n暂无任务\n━━━━━━━━━━━━━━", nil
	}

	completedCount := 0
	failedCount := 0
	cancelledCount := 0
	var totalBytes int64
	var earliestCreated, latestUpdated int64

	for _, t := range tasks {
		st := string(t.Status)
		if focusTask != nil && t.ID == focusTask.ID && focusStatus != "" {
			st = focusStatus
		}
		switch st {
		case string(contract.StatusCompleted):
			completedCount++
			if t.FileSize > 0 {
				totalBytes += t.FileSize
			}
		case string(contract.StatusFailed):
			failedCount++
		case string(contract.StatusCancelled):
			cancelledCount++
		}
		if t.CreatedAt > 0 && (earliestCreated == 0 || t.CreatedAt < earliestCreated) {
			earliestCreated = t.CreatedAt
		}
		if t.UpdatedAt > 0 && t.UpdatedAt > latestUpdated {
			latestUpdated = t.UpdatedAt
		}
	}

	activeCount := totalCount - completedCount - failedCount - cancelledCount
	if activeCount < 0 {
		activeCount = 0
	}

	var title string
	if activeCount == 0 {
		if completedCount == totalCount {
			title = fmt.Sprintf("✅ <b>媒体组转存完成 (%d/%d)</b>", completedCount, totalCount)
		} else if cancelledCount == totalCount {
			title = fmt.Sprintf("🚫 <b>媒体组任务已取消 (%d/%d)</b>", completedCount, totalCount)
		} else if failedCount == totalCount {
			title = fmt.Sprintf("❌ <b>媒体组转存失败 (%d/%d)</b>", completedCount, totalCount)
		} else {
			title = fmt.Sprintf("⚠️ <b>媒体组转存结束 (%d/%d)</b>", completedCount, totalCount)
		}
	} else {
		title = fmt.Sprintf("📊 <b>媒体组转存看板 (%d/%d)</b>", completedCount, totalCount)
	}

	ratio := 0.0
	if totalCount > 0 {
		ratio = float64(completedCount) / float64(totalCount)
	}
	bar := renderProgressBar(ratio, 10)

	summary := fmt.Sprintf("📌 汇总: ✅%d 🔄%d ❌%d 🚫%d", completedCount, activeCount, failedCount, cancelledCount)
	lines := renderTaskLines(tasks, focusTask, focusStatus, focusErr)

	var b strings.Builder
	b.WriteString(title)
	b.WriteString("\n")
	b.WriteString(bar)
	b.WriteString("\n━━━━━━━━━━━━━━\n")
	b.WriteString(summary)
	b.WriteString("\n")
	for _, line := range lines {
		b.WriteString(line)
		b.WriteString("\n")
	}
	b.WriteString("━━━━━━━━━━━━━━")

	if activeCount == 0 {
		var statsParts []string
		if totalBytes > 0 {
			statsParts = append(statsParts, fmt.Sprintf("📦 总大小: <code>%s</code>", formatSize(totalBytes)))
		}
		if earliestCreated > 0 && latestUpdated > earliestCreated {
			dur := time.Duration(latestUpdated-earliestCreated) * time.Millisecond
			dur = dur.Round(time.Second)
			if dur > 0 {
				statsParts = append(statsParts, fmt.Sprintf("⏱ 耗时: <code>%s</code>", dur.String()))
			}
		}
		if len(statsParts) > 0 {
			b.WriteString("\n")
			b.WriteString(strings.Join(statsParts, " | "))
		}
		if folder != "" && completedCount > 0 {
			b.WriteString(fmt.Sprintf("\n📁 目录: <code>%s</code>", escapeHTMLText(folder)))
		}
	}

	var buttons [][]tgclient.Button
	var gid int64
	for _, t := range tasks {
		if t.GroupedID.Valid && t.GroupedID.Int64 > 0 {
			gid = t.GroupedID.Int64
			break
		}
	}

	if activeCount > 0 && gid != 0 {
		buttons = [][]tgclient.Button{{{
			Text: groupCancelBtn,
			Data: fmt.Sprintf("cancel_group_confirm_%d", gid),
		}}}
	} else if activeCount == 0 && failedCount > 0 && gid != 0 {
		buttons = [][]tgclient.Button{{{
			Text: fmt.Sprintf("🔄 一键重试失败项 (%d)", failedCount),
			Data: fmt.Sprintf("retry_group_failed_%d", gid),
		}}}
	}

	return b.String(), buttons
}

// shortenFileName 智能缩短文件名，保持扩展名完整
func shortenFileName(fileName string, maxLen int) string {
	r := []rune(fileName)
	if len(r) <= maxLen {
		return fileName
	}
	ext := filepath.Ext(fileName)
	base := strings.TrimSuffix(fileName, ext)
	baseRunes := []rune(base)
	extRunes := []rune(ext)

	avail := maxLen - len(extRunes) - 1 // 1 for ellipsis '…'
	if avail <= 4 {
		return string(r[:maxLen-1]) + "…"
	}
	startKeep := (avail * 3) / 5
	endKeep := avail - startKeep
	return string(baseRunes[:startKeep]) + "…" + string(baseRunes[len(baseRunes)-endKeep:]) + ext
}

// refreshGroupMonitor 刷新媒体组聚合看板消息（带 1 秒高频防抖保护）
func (a *App) refreshGroupMonitor(ctx context.Context, t *store.Task, focusStatus string, focusErr error) {
	if t == nil || !t.GroupedID.Valid || a.notices == nil {
		return
	}
	gid := t.GroupedID.Int64

	isTerminalEvent := focusStatus == string(contract.StatusCompleted) ||
		focusStatus == string(contract.StatusFailed) ||
		focusStatus == string(contract.StatusCancelled)

	gMonitorThrottle.mu.Lock()
	last := gMonitorThrottle.lastEdit[gid]
	timer, hasTimer := gMonitorThrottle.timers[gid]
	elapsed := time.Since(last)

	// 非终态过程事件如果距离上次编辑小于 1 秒，防抖合批处理
	if !isTerminalEvent && elapsed < 1*time.Second {
		if !hasTimer {
			delay := 1*time.Second - elapsed
			taskCopy := *t
			gMonitorThrottle.timers[gid] = time.AfterFunc(delay, func() {
				gMonitorThrottle.mu.Lock()
				delete(gMonitorThrottle.timers, gid)
				gMonitorThrottle.mu.Unlock()
				a.refreshGroupMonitor(context.Background(), &taskCopy, "", nil)
			})
		}
		gMonitorThrottle.mu.Unlock()
		return
	}

	// 立即刷新：取消已有定时器并记录最新编辑时间
	if hasTimer {
		timer.Stop()
		delete(gMonitorThrottle.timers, gid)
	}
	gMonitorThrottle.lastEdit[gid] = time.Now()
	gMonitorThrottle.mu.Unlock()

	tasks, err := a.repo.FindByGroupID(ctx, gid)
	if err != nil || len(tasks) == 0 {
		a.log.Warn("刷新媒体组看板找不到任务", "gid", gid, "err", err)
		return
	}

	// 检查是否全组已进入终态
	allTerminal := true
	for _, it := range tasks {
		st := it.Status
		if focusTaskID := t.ID; it.ID == focusTaskID && focusStatus != "" {
			st = contract.TaskStatus(focusStatus)
		}
		if st != contract.StatusCompleted && st != contract.StatusFailed && st != contract.StatusCancelled {
			allTerminal = false
			break
		}
	}
	if allTerminal {
		gMonitorThrottle.mu.Lock()
		delete(gMonitorThrottle.lastEdit, gid)
		gMonitorThrottle.mu.Unlock()
	}

	chatID, ok := noticeChatID(*t)
	if !ok {
		a.log.Warn("刷新媒体组看板找不到 chat", "taskId", t.ID)
		return
	}

	msgID := 0
	if t.MsgID.Valid && t.MsgID.Int64 > 0 {
		msgID = int(t.MsgID.Int64)
	} else {
		for _, sibling := range tasks {
			if sibling.MsgID.Valid && sibling.MsgID.Int64 > 0 {
				msgID = int(sibling.MsgID.Int64)
				break
			}
		}
	}
	if msgID == 0 {
		a.log.Warn("刷新媒体组看板无 msg_id", "gid", gid, "taskId", t.ID)
		return
	}

	folder := "/"
	if a.drives != nil {
		if d, err := a.drives.DefaultDrive(ctx, t.UserID); err == nil && d != nil {
			folder = d.RemotePath(a.cfg.RemoteBase)
		}
	}

	text, buttons := renderGroupMonitor(tasks, t, focusStatus, folder, focusErr)

	if len(buttons) > 0 {
		err = a.notices.EditWithButtons(ctx, chatID, msgID, text, buttons)
	} else {
		err = a.notices.EditMessage(ctx, chatID, msgID, text)
	}
	if err != nil {
		a.log.Warn("编辑媒体组看板消息失败", "gid", gid, "msgId", msgID, "err", err)
	}
}
