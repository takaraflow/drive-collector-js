package shadow

import (
	"context"
	"testing"

	"github.com/gotd/td/tg"
)

// TestOnUpdateRecordsButNeverErrors 影子模式的核心保证。
//
// onUpdate 必须恒返回 nil 且不 panic:它一旦返回错误,gotd 会认为
// handler 失败并可能断开重连 —— 那会让 Go 侧的观察流出现空洞,
// 比对结果失真。
func TestOnUpdateRecordsButNeverErrors(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()

	cases := []struct {
		name string
		u    tg.UpdatesClass
	}{
		{"nil", nil},
		{"UpdateShort", &tg.UpdateShort{Date: 1700000000, Update: updateNewMessage(42)}},
		{"Updates", &tg.Updates{Updates: []tg.UpdateClass{updateNewMessage(1), updateNewMessage(2)}}},
		{"UpdatesCombined", &tg.UpdatesCombined{Updates: []tg.UpdateClass{updateNewMessage(3)}}},
		{"UpdatesTooLong", &tg.UpdatesTooLong{}},
		{"UpdateShortMessage", &tg.UpdateShortMessage{Date: 1, ID: 9, UserID: 12345}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := c.onUpdate(ctx, tc.u); err != nil {
				t.Errorf("onUpdate 返回了 %v —— 影子模式必须恒返回 nil", err)
			}
		})
	}

	// nil update 不产生观察,但其余每条都必须留下记录
	if c.observer.Count != len(cases)-1 {
		t.Errorf("记录 %d 次,期望 %d(nil 不计入)", c.observer.Count, len(cases)-1)
	}
}

func updateNewMessage(pts int) *tg.UpdateNewMessage {
	return &tg.UpdateNewMessage{
		Message:  &tg.MessageEmpty{ID: 1},
		Pts:      pts,
		PtsCount: 1,
	}
}

// TestObserverSummary 摘要必须是可比的 —— 比对就靠它。
func TestObserverSummary(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()

	before := c.observer.Count
	_ = c.onUpdate(ctx, &tg.Updates{Updates: []tg.UpdateClass{
		updateNewMessage(1), updateNewMessage(2), updateNewMessage(3),
	}})
	_ = c.onUpdate(ctx, &tg.UpdateShort{Date: 1, Update: updateNewMessage(4)})
	_ = c.onUpdate(ctx, &tg.UpdatesTooLong{})

	if got := c.observer.Count - before; got != 3 {
		t.Errorf("记录 %d 次,期望 3(nil update 不该计入)", got)
	}

	s := c.observer.Summary()
	if s.ByType["Updates"] != 1 {
		t.Errorf("Updates 计数 = %d,期望 1", s.ByType["Updates"])
	}
	if s.ByType["UpdatesTooLong"] != 1 {
		t.Errorf("UpdatesTooLong 计数 = %d,期望 1", s.ByType["UpdatesTooLong"])
	}
	if s.Window == "" {
		t.Error("窗口时长不应为空")
	}

	// 指纹必须稳定:同一批观察两次算出同一个值,否则没法比对。
	f1 := Fingerprint(Observation{UpdateType: "Updates", Points: 3, DCID: 2, TextLen: 10})
	f2 := Fingerprint(Observation{UpdateType: "Updates", Points: 3, DCID: 2, TextLen: 10})
	if f1 != f2 {
		t.Errorf("指纹不稳定: %q vs %q", f1, f2)
	}
	f3 := Fingerprint(Observation{UpdateType: "Updates", Points: 4, DCID: 2, TextLen: 10})
	if f1 == f3 {
		t.Error("不同观察不应得到相同指纹")
	}
}

// TestNewRejectsMissingConfig 配置不全必须报错,不能静默降级。
func TestNewRejectsMissingConfig(t *testing.T) {
	sess := sampleSession(t)

	if _, err := New(Config{Session: sess}); err == nil {
		t.Error("缺 API_ID/API_HASH 应报错")
	}
	if _, err := New(Config{APIID: 1, APIHash: "h"}); err == nil {
		t.Error("缺 session 应报错")
	}
}

// TestNewDoesNotConnect 构造客户端不应发起任何网络连接 ——
// 这是「影子模式不干扰线上」的前提。
func TestNewDoesNotConnect(t *testing.T) {
	c, err := New(Config{
		APIID:   12345,
		APIHash: "0123456789abcdef0123456789abcdef",
		Session: sampleSession(t),
		Log:     quietLogger(),
	})
	if err != nil {
		t.Fatalf("New 失败: %v", err)
	}
	if c.tg == nil {
		t.Fatal("内部客户端未初始化")
	}
	if c.observer.Count != 0 {
		t.Error("构造阶段不应有任何观察 —— 说明连上了")
	}
}

func newTestClient(t *testing.T) *Client {
	t.Helper()
	c, err := New(Config{
		APIID:   12345,
		APIHash: "0123456789abcdef0123456789abcdef",
		Session: sampleSession(t),
		Log:     quietLogger(),
	})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	return c
}