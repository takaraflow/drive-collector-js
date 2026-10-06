package telegram

import (
	"strings"

	"github.com/gotd/td/telegram/message/entity"
	"github.com/gotd/td/telegram/message/html"
	"github.com/gotd/td/tg"
)

// styleText 把 Bot API 风格的 HTML 文本转成 MTProto 要的
// (纯文本, entities)。
//
// 为什么需要它:Bot HTTP API 有 parse_mode='HTML',服务端替你把标签转成
// entities;MTProto 的 messages.sendMessage 压根没有 parse_mode 字段,
// 只有 entities —— offset/length 得自己算,且长度按 UTF-16 code unit 算。
// 忘了填 entities 的症状就是「<b>加粗</b> 原样显示出来」。
//
// 解析失败时原样返回、不带样式:宁可让用户看见裸标签,也不能丢消息。
// 动态内容(任务名、报错)都已经过 escapeHTMLText,正常不会走到这条分支。
//
// 用 Raw() 而非 Complete():后者会裁掉最后一个格式块之后的尾部空白,
// 那是在替用户改文本。Raw 只去标签,不改内容;排序交给 SortEntities。
func styleText(text string) (string, []tg.MessageEntityClass) {
	var b entity.Builder
	if err := html.HTML(strings.NewReader(text), &b, html.Options{}); err != nil {
		return text, nil
	}
	msg, entities := b.Raw()
	entity.SortEntities(entities)
	return msg, entities
}
