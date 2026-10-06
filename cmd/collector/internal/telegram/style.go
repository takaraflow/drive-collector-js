package telegram

import (
	"context"
	"strings"

	"github.com/gotd/td/telegram/message"
	"github.com/gotd/td/telegram/message/entity"
	"github.com/gotd/td/telegram/message/html"
	"github.com/gotd/td/telegram/message/styling"
	"github.com/gotd/td/tg"
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
// 降级是刻意的:gotd 的 StyledText 先解析后发送,解析失败时服务端根本
// 什么都没收到,退回纯文本重发不会重复。宁可让用户看见裸标签,也不能让
// 状态消息凭空消失 —— 任务卡在「上传中」而没有任何提示,比丑糟得多。
// 动态内容(任务名、报错)都已过 escapeHTMLText,正常不会走到这条分支。
func (c *Client) sendOrEdit(ctx context.Context, s styledSender, text string) (tg.UpdatesClass, error) {
	upd, err := s.StyledText(ctx, styledText(text))
	if err == nil {
		return upd, nil
	}
	c.log.Warn("HTML 解析失败,退回纯文本", "err", err)
	return s.Text(ctx, text)
}
