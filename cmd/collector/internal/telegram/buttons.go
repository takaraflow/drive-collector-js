package telegram

import (
	"context"
	"fmt"

	"github.com/gotd/td/telegram/message/markup"
	"github.com/gotd/td/tg"
)

// Button 是内联按钮。
//
// 抽象成自己的类型而不是直接用 tg.KeyboardInlineButton:
// 业务代码不该依赖 gotd 的类型,否则换库就得重写所有命令。
type Button struct {
	Text string
	// Data 是 callback payload。
	//
	// 【64 字节上限】—— Telegram 的硬限制。超了服务端会静默丢弃
	// callback,表现为「点了没反应」。JS 侧在 retry_confirm_many_ 上撞过
	// 一次,加了长度检查;这里从构造时就拦住。
	Data string
	// URL 非空时渲染成链接按钮(不触发 callback)。
	URL string
}

// CallbackDataLimit 是 Telegram 对 callback_data 的硬上限。
const CallbackDataLimit = 64

// InlineKeyboard 把按钮组装成 ReplyMarkup。
//
// Data 超长会被截断并记录 —— 静默丢 callback 比截断更难查。
func InlineKeyboard(log Logger, rows ...[]Button) tg.ReplyMarkupClass {
	var kbRows []tg.KeyboardInlineButtonRow
	for _, row := range rows {
		var btns []tg.KeyboardInlineButton
		for _, b := range row {
			switch {
			case b.URL != "":
				btns = append(btns, markup.URL(b.Text, b.URL))
			case len(b.Data) > CallbackDataLimit:
				if log != nil {
					log.Warn("callback data 超 64 字节,已截断",
						"text", b.Text, "原长", len(b.Data))
				}
				btns = append(btns, markup.Callback(b.Text, []byte(b.Data[:CallbackDataLimit])))
			default:
				btns = append(btns, markup.Callback(b.Text, []byte(b.Data)))
			}
		}
		if len(btns) > 0 {
			kbRows = append(kbRows, markup.InlineButtonRow(btns...))
		}
	}
	return markup.InlineKeyboard(kbRows...)
}

// sendWithMarkup 发消息并带内联键盘,返回新消息的 id。
//
// 走 API() 而不是 gotd 的 SendMessage 便捷方法:后者把回执扔了,
// 拿不到 id —— 而任务状态消息必须知道自己的 id(要写进 tasks.msg_id,
// 后面每个阶段都编辑这一条)。
func (c *Client) sendWithMarkup(ctx context.Context, chatID int64, text string, markup tg.ReplyMarkupClass) (int, error) {
	peer, err := c.peerFor(ctx, chatID)
	if err != nil {
		return 0, err
	}
	req := &tg.MessagesSendMessageRequest{
		Peer:        peer,
		Message:     text,
		ReplyMarkup: markup,
	}
	if req.RandomID == 0 {
		id, err := c.tg.RandInt64()
		if err != nil {
			return 0, err
		}
		req.RandomID = id
	}
	updates, err := c.tg.API().MessagesSendMessage(ctx, req)
	if err != nil {
		return 0, fmt.Errorf("telegram: 发送消息失败(chat=%d): %w", chatID, err)
	}
	return messageIDOf(updates), nil
}

func (c *Client) sendWithButtons(ctx context.Context, chatID int64, text string, buttons [][]Button) error {
	_, err := c.sendWithMarkup(ctx, chatID, text, InlineKeyboard(c.log, buttons...))
	return err
}

// SendWithButtonsAndID 发带按钮的消息并返回消息 id —— 任务状态消息用。
func (c *Client) SendWithButtonsAndID(ctx context.Context, chatID int64, text string, buttons [][]Button) (int, error) {
	return c.sendWithMarkup(ctx, chatID, text, InlineKeyboard(c.log, buttons...))
}

// EditWithMarkup 改消息并更新键盘。
//
// 进度更新、翻页都走这里 —— 用户看到的是同一条消息在变,
// 而不是刷出一堆新消息。
func (c *Client) EditWithMarkup(ctx context.Context, chatID int64, msgID int, text string, markup tg.ReplyMarkupClass) error {
	peer, err := c.peerFor(ctx, chatID)
	if err != nil {
		return err
	}
	// 用 gotd 生成的方法而不是 Invoke + 手写 result。
	//
	// messages.editMessage 返回的是 Updates 而不是 AffectedMessages,
	// 手写 result 会让解码器拿 Updates 去填 AffectedMessages,报
	// "unexpected id 0x74ae4240"(那是 updates 的 TL id)——
	// 生产现场:所有编辑消息与按钮回应全挂,而 sendMessage 正常,
	// 于是表现为「/files 一直转圈、按钮点了没反应」。
	if _, err := c.tg.API().MessagesEditMessage(ctx, &tg.MessagesEditMessageRequest{
		Peer:        peer,
		ID:          msgID,
		Message:     text,
		ReplyMarkup: markup,
	}); err != nil {
		return fmt.Errorf("telegram: 编辑消息失败(chat=%d msg=%d): %w", chatID, msgID, err)
	}
	return nil
}

// SendWithButtons 发带按钮的消息 —— 给 Dispatcher 用。
func (c *Client) SendWithButtons(ctx context.Context, chatID int64, text string, buttons [][]Button) error {
	return c.sendWithButtons(ctx, chatID, text, buttons)
}

// EditWithButtons 改消息并更新按钮。
func (c *Client) EditWithButtons(ctx context.Context, chatID int64, msgID int, text string, buttons [][]Button) error {
	return c.EditWithMarkup(ctx, chatID, msgID, text, InlineKeyboard(c.log, buttons...))
}

// AnswerCallback 回应按钮点击。
//
// 必须在 15 秒内回应,否则客户端会显示转圈直到超时。
// B 方案的管理命令(封禁/改角色)依赖这个做二次确认。
func (c *Client) AnswerCallback(ctx context.Context, callbackID int64, text string, alert bool) error {
	// 同 EditWithMarkup:messages.setBotCallbackAnswer 返回 Bool,
	// 不是 BotCallbackAnswer。手写 result 会报
	// "unexpected id 0x997275b5"(boolTrue)——按钮点了永远转圈。
	if _, err := c.tg.API().MessagesSetBotCallbackAnswer(ctx, &tg.MessagesSetBotCallbackAnswerRequest{
		QueryID: callbackID,
		Message: text,
		Alert:   alert,
	}); err != nil {
		return fmt.Errorf("telegram: 回应按钮失败: %w", err)
	}
	return nil
}

// CallbackData 从 update 里取出按钮的 payload。
// callbackID 传回 AnswerCallback 时必须与原始 QueryID 完全一致 ——
// Telegram 靠它匹配「回应哪次点击」。
// Telegram 靠它匹配「回应哪次点击」。
func CallbackData(u Update) (callbackID int64, data string, ok bool) {
	q, isCallback := u.Raw.(*tg.UpdateBotCallbackQuery)
	if !isCallback {
		return 0, "", false
	}
	return q.QueryID, string(q.Data), true
}

// Logger 是 telegram 包的最小日志依赖。
type Logger interface {
	Info(msg string, args ...any)
	Warn(msg string, args ...any)
}
