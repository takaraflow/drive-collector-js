package telegram

import (
	"context"
	"strings"

	"github.com/gotd/td/telegram/message"
	"github.com/gotd/td/telegram/message/entity"
	"github.com/gotd/td/telegram/message/html"
	"github.com/gotd/td/telegram/message/styling"
	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// styledText 把 Bot API 风格的 HTML 变成 gotd 的样式选项。
//
// 为什么需要它:Bot HTTP API 有 parse_mode='HTML',服务端替你把标签
// 转成 entities;MTProto 的 messages.sendMessage 压根没有 parse_mode
// 字段,只有 entities(offset/length 得自己算,长度按 UTF-16 code unit)。
// 忘了这层翻译的症状就是「<b>加粗</b> 原样显示出来」。
//
// 用 gotd 的 html 包而不是自己扫标签:它跟 TDLib 同源,偏移、嵌套、
// 代理对都算对了。自己重写一遍 UTF-16 偏移是这类代码最常见的 bug 来源。
func styledText(text string) message.StyledTextOption {
	return styling.Custom(func(eb *entity.Builder) error {
		return html.HTML(strings.NewReader(text), eb, html.Options{})
	})
}

// styledSender 是发送与编辑两条路径的共同面 —— *message.Builder 和
// *message.EditMessageBuilder 都满足。抽出来是为了 sendOrEdit 一份降级逻辑。
type styledSender interface {
	StyledText(ctx context.Context, texts ...message.StyledTextOption) (tg.UpdatesClass, error)
	Text(ctx context.Context, msg string) (tg.UpdatesClass, error)
}

// sendOrEdit 发或改一条 HTML 样式消息。
//
// 降级是刻意的:gotd 的 StyledText 先解析后发送，若本地 HTML 解析失败，
// 剥离 HTML 标签退回纯文本重发，绝不将裸 <b> 标签原样暴露给用户。
// 若内容本身合规只是遇到 MESSAGE_NOT_MODIFIED 等网络/服务端无变更状态，
// 优雅忽略或上抛给 flood 限流层重试，杜绝因服务端瞬态报错误降级为裸标签的问题。
func (c *Client) sendOrEdit(ctx context.Context, s styledSender, text string) (tg.UpdatesClass, error) {
	var upd tg.UpdatesClass

	action := func() error {
		u, err := s.StyledText(ctx, styledText(text))
		if err == nil {
			upd = u
			return nil
		}
		// 编辑消息未发生变化时返回 MESSAGE_NOT_MODIFIED，视为成功
		if tgerr.Is(err, "MESSAGE_NOT_MODIFIED") {
			return nil
		}

		// 检查是否是本地 HTML 解析失败
		var tb entity.Builder
		if parseErr := styling.Perform(&tb, styledText(text)); parseErr != nil {
			c.log.Warn("HTML 解析失败, 剥除标签退回纯文本", "err", parseErr)
			u, err = s.Text(ctx, stripHTML(text))
			if err != nil {
				return err
			}
			upd = u
			return nil
		}

		// 本地解析正常说明是网络或 RPC 错误，由外层 flood 或调用方处理
		return err
	}

	if c.flood != nil {
		if err := c.flood.ExecuteWithRetry(ctx, action); err != nil {
			return nil, err
		}
		return upd, nil
	}

	if err := action(); err != nil {
		return nil, err
	}
	return upd, nil
}
