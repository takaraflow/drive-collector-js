package telegram

import (
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"
)

// newClientWithLog 造一个只带 logger 的 Client,不连任何东西。
//
// dispatch 只用到 log 和 peers 两个字段 —— 不碰网络就能测。
func newClientWithLog(lv slog.Level) (*Client, *strings.Builder) {
	var buf strings.Builder
	h := slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: lv})
	return &Client{log: slog.New(h), peers: newPeerCache()}, &buf
}

// TestDispatchLogsUpdatesTooLong 收到 UpdatesTooLong 必须留痕。
//
// 这是「消息静默消失」的经典现场:服务端判定客户端落后太多,
// 改推 UpdatesTooLong 要求重新拉差量。如果这里只记 Debug 级,
// 生产(Info)下就是一片安静 —— 排查时完全看不出发生过什么。
//
// 之前 `未识别的 update 容器` 和 `暂不处理的 update` 都是 Debug,
// 生产默认不可见,等于把「消息丢了」伪装成「一切正常」。
func TestDispatchLogsUpdatesTooLong(t *testing.T) {
	c, buf := newClientWithLog(slog.LevelInfo)

	if err := c.dispatch(nil)(context.Background(), &tg.UpdatesTooLong{}); err != nil {
		t.Fatalf("不该报错:%v", err)
	}

	out := buf.String()
	if !strings.Contains(out, "UpdatesTooLong") {
		t.Errorf("Info 级下必须能看到 UpdatesTooLong,实际输出:%q", out)
	}
}

// TestDispatchLogsShortSentMessage 自己发消息的回复不能静默丢弃。
//
// gotd 的 Client.SendMessage 末尾是 `return c.processUpdates(updates)`
// (telegram/send_message.go) —— 也就是说每次发消息返回的
// UpdateShortSentMessage 都会走回这里。它掉进 default 分支,
// 意味着「发消息」这条最关键的路径在生产日志里毫无痕迹。
func TestDispatchLogsShortSentMessage(t *testing.T) {
	c, buf := newClientWithLog(slog.LevelInfo)

	short := &tg.UpdateShortSentMessage{ID: 12345, Pts: 7, PtsCount: 1}
	if err := c.dispatch(nil)(context.Background(), short); err != nil {
		t.Fatalf("不该报错:%v", err)
	}

	out := buf.String()
	// 断言日志文本而不是 TypeName() —— 后者首字母小写(updateShortSentMessage),
	// 绑死它会让测试因为大小写而脆。
	if !strings.Contains(out, "已发送消息的回执") {
		t.Errorf("自己发消息的回包必须留痕,实际输出:%q", out)
	}
}

// TestDispatchStillRoutesNormalShort 正常的 UpdateShort 仍然送达 handler。
//
// 这条守着「加了日志别把正常路径弄坏」——UpdateShort 是最常见的
// 下发形态(短消息会被转成它),它必须原样进 handler。
func TestDispatchStillRoutesNormalShort(t *testing.T) {
	c, _ := newClientWithLog(slog.LevelInfo)

	var got Kind
	h := func(_ context.Context, u Update) error {
		got = u.Kind
		return nil
	}

	upd := &tg.UpdateShort{
		Update: &tg.UpdateNewMessage{
			Message: &tg.Message{
				ID:      1,
				PeerID:  &tg.PeerUser{UserID: 7428626313},
				Message: "/start",
				Date:    1791100000,
			},
		},
	}
	if err := c.dispatch(h)(context.Background(), upd); err != nil {
		t.Fatalf("不该报错:%v", err)
	}
	if got != KindNewMessage {
		t.Errorf("kind = %q,期望 %q", got, KindNewMessage)
	}
}

// TestDispatchStoresAccessHashFromUpdates 顺路收下 AccessHash。
//
// 容器里带着 Users 是免费的 —— 收下来后面发消息就不用额外问服务端。
// 发私聊消息必须要 AccessHash,这条路径断了会导致 CHAT_ID_INVALID。
func TestDispatchStoresAccessHashFromUpdates(t *testing.T) {
	c, _ := newClientWithLog(slog.LevelInfo)

	container := &tg.Updates{
		Updates: []tg.UpdateClass{&tg.UpdateNewMessage{
			Message: &tg.Message{
				ID:      2,
				PeerID:  &tg.PeerUser{UserID: 555},
				Message: "hi",
				Date:    1791100000,
			},
		}},
		Users: []tg.UserClass{&tg.User{ID: 555, AccessHash: 0xabc}},
	}
	if err := c.dispatch(nil)(context.Background(), container); err != nil {
		t.Fatalf("不该报错:%v", err)
	}

	h, ok := c.peers.get(555)
	if !ok || h != 0xabc {
		t.Errorf("AccessHash 没被收下:ok=%v hash=%#x", ok, h)
	}
}

// 让编译器确认 dispatch 返回的是 gotd 认的 handler 类型。
var _ telegram.UpdateHandlerFunc = (*Client)(nil).dispatch(nil)
