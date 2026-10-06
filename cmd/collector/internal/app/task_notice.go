package app

// 任务状态消息 —— 用户投递文件后看到的那一条,从「已捕获」一路编辑到
// 「转存成功 / 失败」。
//
// 与 JS 侧 addTask 的 statusMsg 是同一件事:建任务时发一条带取消按钮的
// 消息,把它的 id 写进 tasks.msg_id,之后每个阶段都【编辑这一条】,
// 而不是刷新消息。用户于是全程盯着一行看进度。
//
// 缺了它的症状:用户发完文件只看到「已读」,没有任何回音 —— 任务在
// 后台跑完了他也不知道。Go 接管后就是这个状态:createTaskFrom 建完
// 任务直接入队,一句话不发。

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// 文案与 JS 侧 STRINGS.task 逐字一致:切换期两边可能同时在跑,
// 用户看到的必须是同一句话。
const (
	noticeCaptured    = "🚀 <b>已捕获文件任务</b>\n正在排队处理..."
	noticeDownloading = "📥 正在下载资源..."
	noticeUploading   = "📤 <b>资源拉取完成，正在启动转存...</b>"
	noticeSuccess     = "✅ <b>文件转存成功</b>\n\n📄 名称: <code>%s</code>\n📂 目录: <code>%s</code>"
	noticeUploadFail  = "❌ <b>转存失败</b>\n\n原因: <code>%s</code>\n你可以重试，或重新发送文件。"
	noticeFail        = "❌ <b>处理失败</b>\n\n%s"
	noticeCancelled   = "🚫 任务已取消。"

	noticeCancelBtn = "🚫 取消排队"
	noticeRetryBtn  = "🔄 重试"

	// noticeReasonLimit 是失败原因截断长度。rclone 的错误能有一整段
	// 日志,整段塞进消息会变成一屏乱码,而用户只需要知道「哪一步失败」。
	noticeReasonLimit = 200
)

// postNotice 建任务时发的那条状态消息 —— 返回它的 id 给 tasks.msg_id。
//
// 发不出去也要继续建任务:文件已经在路上了,不建任务等于把它丢掉,
// 而用户下次发还会再收到一次。返回 0 表示没有状态消息,后续阶段会退回
// 发新消息(见 notify）。
func (a *App) postNotice(ctx context.Context, chatID int64, taskID string) int {
	if a.notices == nil {
		return 0
	}
	msgID, err := a.notices.SendWithButtonsAndID(ctx, chatID, noticeCaptured,
		[][]tgclient.Button{{
			{Text: noticeCancelBtn, Data: "cancel_confirm_" + taskID},
		}})
	if err != nil {
		a.log.Error("发任务状态消息失败,任务仍会继续处理", "taskId", taskID, "err", err)
		return 0
	}
	return msgID
}

// notify 把任务状态写回那一条消息。
//
// 没有 msg_id(接管前建的老任务、或建任务时发消息失败)时退回发一条
// 新消息 —— 与 JS 的 safeSendStatusMessage 同款。不静默跳过:用户
// 唯一能看到的进度就是这条消息。
func (a *App) notify(ctx context.Context, t *store.Task, text string, buttons [][]tgclient.Button) {
	if t == nil || !t.SourceRef.Valid || a.notices == nil {
		return
	}
	chatID, ok := noticeChatID(*t)
	if !ok {
		a.log.Warn("任务通知找不到 chat,已跳过", "taskId", t.ID)
		return
	}

	if t.MsgID.Valid && t.MsgID.Int64 > 0 {
		var err error
		if len(buttons) > 0 {
			err = a.notices.EditWithButtons(ctx, chatID, int(t.MsgID.Int64), text, buttons)
		} else {
			err = a.notices.EditMessage(ctx, chatID, int(t.MsgID.Int64), text)
		}
		if err == nil {
			return
		}
		// 编辑失败最常见的是消息被用户删了 —— 那就补发一条新的,
		// 而不是让这条任务从此静默。
		a.log.Warn("编辑任务状态消息失败,改发新消息", "taskId", t.ID, "err", err)
	}
	if len(buttons) > 0 {
		if _, err := a.notices.SendWithButtonsAndID(ctx, chatID, text, buttons); err != nil {
			a.log.Error("补发任务状态消息失败", "taskId", t.ID, "err", err)
		}
		return
	}
	if err := a.notices.SendMessage(ctx, chatID, text); err != nil {
		a.log.Error("补发任务状态消息失败", "taskId", t.ID, "err", err)
	}
}

// noticeChatID 取任务该回消息到哪个会话。
//
// 优先用 tasks.chat_id(与 JS 侧 addTask 写的一致),接管前建的老任务
// 那一列是空的,退回从 source_ref 里解析 —— telegram_media 任务一定
// 有 source_ref,所以这条路覆盖得到全部存量数据。
func noticeChatID(t store.Task) (int64, bool) {
	if t.ChatID.Valid {
		if id, err := strconv.ParseInt(strings.TrimSpace(t.ChatID.String), 10, 64); err == nil {
			return id, true
		}
	}
	if t.SourceRef.Valid {
		if chatID, _, err := ParseSourceRef(t.SourceRef.String); err == nil {
			return chatID, true
		}
	}
	return 0, false
}

// noticeReason 把错误压成一行能塞进消息的短文本。
//
// rclone 的失败信息常带多行日志和引号,直接进 <code> 会把版式冲垮,
// 也会把内部路径暴露成一屏噪音。
func noticeReason(err error) string {
	if err == nil {
		return ""
	}
	s := strings.Join(strings.Fields(err.Error()), " ")
	r := []rune(s)
	if len(r) > noticeReasonLimit {
		return string(r[:noticeReasonLimit]) + "…"
	}
	return s
}

// noticeSuccessText 成功文案 —— 目录取自用户当前设的保存路径。
//
// 查不到网盘不挡成功:文件已经传上去了,少一行目录不该翻脸说失败。
func (a *App) noticeSuccessText(ctx context.Context, t store.Task) string {
	folder := "/"
	if a.drives != nil {
		if d, err := a.drives.DefaultDrive(ctx, t.UserID); err != nil {
			a.log.Warn("查网盘失败,成功文案里不写目录", "taskId", t.ID, "err", err)
		} else if d != nil {
			folder = d.RemotePath(a.cfg.RemoteBase)
		}
	}
	name := t.FileName.String
	if name == "" {
		name = "未知文件"
	}
	return fmt.Sprintf(noticeSuccess, escapeHTMLText(name), escapeHTMLText(folder))
}
