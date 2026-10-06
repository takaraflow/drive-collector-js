package telegram

import (
	"context"
	"fmt"

	"github.com/gotd/td/tg"
)

// intSlice 把 []int64 转成 Telegram API 要的 []int。
func intSlice(ids []int64) []int {
	out := make([]int, len(ids))
	for i, v := range ids {
		out[i] = int(v)
	}
	return out
}

// DeleteMessages 删除消息(revoke = 双向删除)。
//
// 绑定流程用它删掉用户刚发的密码/2FA 一次性验证码 —— 凭据留在
// 聊天记录里就是隐患。删除失败只降级为日志:凭据已经拿到手了,
// 删不掉不应该让整条绑定链路跟着失败。
func (c *Client) DeleteMessages(ctx context.Context, chatID int64, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	if _, err := c.tg.API().MessagesDeleteMessages(ctx, &tg.MessagesDeleteMessagesRequest{
		Revoke: true,
		ID:     intSlice(ids),
	}); err != nil {
		return fmt.Errorf("telegram: 删除消息失败: %w", err)
	}
	return nil
}

// CallbackContext 是一次按钮点击的完整上下文。
//
// CallbackData 只给了 payload,而编辑面板需要知道【在哪个会话、
// 哪条消息】上编辑 —— 所以单独一个提取函数,连同 UserID 一起给。
type CallbackContext struct {
	CallbackID int64
	ChatID     int64
	UserID     int64
	MsgID      int
	Data       string
}

// CallbackOf 从 update 里取回调上下文。
//
// 只支持私聊场景:Peer 是 PeerUser。群里点按钮的情况这个 bot 没有
// (所有面板都发在私聊),遇到就返回 false 交给调用方忽略。
func CallbackOf(u Update) (CallbackContext, bool) {
	q, ok := u.Raw.(*tg.UpdateBotCallbackQuery)
	if !ok {
		return CallbackContext{}, false
	}
	ctx := CallbackContext{
		CallbackID: q.QueryID,
		UserID:     q.UserID,
		MsgID:      q.MsgID,
		Data:       string(q.Data),
	}
	if p, isUser := q.Peer.(*tg.PeerUser); isUser {
		ctx.ChatID = p.UserID
	} else if q.UserID != 0 {
		ctx.ChatID = q.UserID
	} else {
		return CallbackContext{}, false
	}
	return ctx, true
}
