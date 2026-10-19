package app

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// renderGroupMonitor 渲染媒体组聚合转存看板
func renderGroupMonitor(tasks []store.Task, focusTask *store.Task, focusStatus string, folder string, focusErr error) (string, [][]tgclient.Button) {
	totalCount := len(tasks)
	if totalCount == 0 {
		return "📊 <b>媒体组转存看板</b>\n━━━━━━━━━━━━━━\n暂无任务\n━━━━━━━━━━━━━━", nil
	}

	completedCount := 0
	failedCount := 0
	cancelledCount := 0

	for _, t := range tasks {
		st := string(t.Status)
		if focusTask != nil && t.ID == focusTask.ID && focusStatus != "" {
			st = focusStatus
		}
		switch st {
		case string(contract.StatusCompleted):
			completedCount++
		case string(contract.StatusFailed):
			failedCount++
		case string(contract.StatusCancelled):
			cancelledCount++
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
		} else {
			title = fmt.Sprintf("⚠️ <b>媒体组转存结束 (%d/%d)</b>", completedCount, totalCount)
		}
	} else {
		title = fmt.Sprintf("📊 <b>媒体组转存看板 (%d/%d)</b>", completedCount, totalCount)
	}

	summary := fmt.Sprintf("📌 汇总: ✅%d 🔄%d ❌%d 🚫%d", completedCount, activeCount, failedCount, cancelledCount)

	lines := make([]string, 0, totalCount)
	for _, t := range tasks {
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
		lines = append(lines, fmt.Sprintf("%s %s (%s)", icon, dispName, statusText))
	}

	var b strings.Builder
	b.WriteString(title)
	b.WriteString("\n━━━━━━━━━━━━━━\n")
	b.WriteString(summary)
	b.WriteString("\n")
	for _, line := range lines {
		b.WriteString(line)
		b.WriteString("\n")
	}
	b.WriteString("━━━━━━━━━━━━━━")

	if activeCount == 0 && folder != "" && completedCount > 0 {
		b.WriteString(fmt.Sprintf("\n📁 目录: <code>%s</code>", escapeHTMLText(folder)))
	}

	var buttons [][]tgclient.Button
	if activeCount > 0 {
		var gid int64
		for _, t := range tasks {
			if t.GroupedID.Valid && t.GroupedID.Int64 > 0 {
				gid = t.GroupedID.Int64
				break
			}
		}
		if gid != 0 {
			buttons = [][]tgclient.Button{{{
				Text: groupCancelBtn,
				Data: fmt.Sprintf("cancel_group_confirm_%d", gid),
			}}}
		}
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

// refreshGroupMonitor 刷新媒体组聚合看板消息
func (a *App) refreshGroupMonitor(ctx context.Context, t *store.Task, focusStatus string, focusErr error) {
	if t == nil || !t.GroupedID.Valid || a.notices == nil {
		return
	}
	gid := t.GroupedID.Int64
	tasks, err := a.repo.FindByGroupID(ctx, gid)
	if err != nil || len(tasks) == 0 {
		a.log.Warn("刷新媒体组看板找不到任务", "gid", gid, "err", err)
		return
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
