package app

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"strconv"
	"strings"
	"time"

	"github.com/gotd/td/tg"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// messageInfo 是从 update 里抽出的、创建任务需要的信息。
//
// 单独抽出来是因为「只取用得到的字段」比「把整个 tg.Message 传下去」
// 安全得多 —— 后者一旦被调用方拿去改,就会触发「已消费对象」的
// 协议错误(重复 update 无法重放,静默丢消息)。
type messageInfo struct {
	ID        int
	ChatID    int64
	SenderID  int64
	GroupedID int64
	HasMedia  bool
	FileName  string
}

// messageOf 从 update 里提取消息信息。
//
// 各种 update 的消息字段藏在不同位置,这里统一收口。
func messageOf(u tgclient.Update) (messageInfo, bool) {
	switch v := u.Raw.(type) {
	case *tg.UpdateNewMessage:
		return fromMessage(v.Message)
	case *tg.UpdateNewChannelMessage:
		return fromMessage(v.Message)
	default:
		return messageInfo{}, false
	}
}

func fromMessage(m tg.MessageClass) (messageInfo, bool) {
	msg, ok := m.(*tg.Message)
	if !ok {
		// 空消息没有可提取的信息
		return messageInfo{}, false
	}
	info := messageInfo{ID: msg.GetID()}
	if from, ok := msg.GetFromID(); ok {
		if user, isUser := from.(*tg.PeerUser); isUser {
			info.SenderID = user.GetUserID()
		}
	}
	if peer, ok := msg.GetPeerID().(*tg.PeerUser); ok {
		info.ChatID = peer.GetUserID()
	}
	if peer, ok := msg.GetPeerID().(*tg.PeerChat); ok {
		info.ChatID = peer.GetChatID()
	}
	gid, _ := msg.GetGroupedID()
	info.GroupedID = gid

	media, hasMedia := msg.GetMedia()
	info.HasMedia = hasMedia && media != nil
	if info.HasMedia {
		info.FileName = fileNameOf(media)
	}
	return info, true
}

// fileNameOf 从媒体里取文件名。
func fileNameOf(m tg.MessageMediaClass) string {
	switch v := m.(type) {
	case *tg.MessageMediaDocument:
		doc, ok := v.Document.(*tg.Document)
		if !ok {
			return ""
		}
		for _, attr := range doc.Attributes {
			if name, ok := attr.(*tg.DocumentAttributeFilename); ok {
				return name.FileName
			}
		}
	case *tg.MessageMediaPhoto:
		return ""
	}
	return ""
}

// newTaskID 生成任务主键。
//
// 用随机 hex 而不是自增 —— 任务 id 会出现在文件名和日志里,
// 可猜测的 id 会泄漏「这个用户一共有多少任务」这类信息。
func newTaskID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand 失败在现代系统上意味着环境已损坏,
		// 此时用时间戳也比让整个服务不可用好。
		return "task-" + strconv.FormatInt(nowMillis(), 36)
	}
	return "task-" + hex.EncodeToString(b[:])
}

// sanitize 把文件名变成安全的本地路径。
//
// 文件名来自 Telegram,是完全不受控的输入:
//   - 可能含 ../(目录穿越)
//   - 可能含 / 或路径分隔符
//   - 可能为空
//
// 这不是洁癖:目录穿越会让下载落到任意可写路径,空文件名会让
// 后续路径拼接把文件写到目录本身。
func sanitize(name string) string {
	name = filepathBase(name)
	if name == "" || name == "." || name == ".." {
		return "unnamed"
	}
	// 只保留可打印的 ASCII,其余替换掉
	var b strings.Builder
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '.' || r == '-' || r == '_' || r == ' ':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	out := b.String()
	if len(out) > 200 {
		out = out[:200]
	}
	// 前导点会造成隐藏文件,也去掉
	return strings.TrimLeft(out, ".")
}

// filepathBase 取路径最后一段,不依赖 path/filepath 的平台行为。
func filepathBase(name string) string {
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		return name[i+1:]
	}
	return name
}

func nullableInt(v int64) sql.NullInt64 {
	if v == 0 {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: v, Valid: true}
}
func nowMillis() int64 { return time.Now().UnixMilli() }

func nullableString(v string) sql.NullString {
	if v == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: v, Valid: true}
}
