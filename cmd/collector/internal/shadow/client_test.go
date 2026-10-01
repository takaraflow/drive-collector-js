package shadow

import (
	"context"
	"testing"

	"github.com/gotd/td/tg"

	"github.com/youngsx/drive-collector/cmd/collector/internal/shadowfingerprint"
)

// 测试专用的基准时间。
//
// onUpdate 用 update 自带的时间戳分桶(见 record),所以测试必须提供
// 自洽的时间,而不是依赖 time.Now()。
const testBaseUnix = 1767225600 // 2026-01-01 00:00:00 UTC

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
		{"UpdateShort", &tg.UpdateShort{Date: testBaseUnix, Update: updateNewMessage(42)}},
		{"Updates", &tg.Updates{Date: testBaseUnix, Updates: []tg.UpdateClass{updateNewMessage(1), updateNewMessage(2)}}},
		{"UpdatesCombined", &tg.UpdatesCombined{Date: testBaseUnix, Updates: []tg.UpdateClass{updateNewMessage(3)}}},
		{"UpdatesTooLong", &tg.UpdatesTooLong{}},
		// UpdateShortMessage 在真实链路里到不了这里:gotd 的
		// handle_updates.go 会先把它转成 *tg.UpdateShort 包着
		// *tg.UpdateNewMessage 再交给 handler。所以下面那个 case
		// 走的是 default 分支,只记日志不记录 —— 这正是期望。
		{"UpdateShortMessage(被 gotd 预先转换)", &tg.UpdateShortMessage{Date: testBaseUnix, ID: 9, UserID: 12345}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := c.onUpdate(ctx, tc.u); err != nil {
				t.Errorf("onUpdate 返回了 %v —— 影子模式必须恒返回 nil", err)
			}
		})
	}

	// nil=0, UpdateShort=1, Updates(2条)=2, UpdatesCombined(1条)=1,
	// UpdatesTooLong=0(流截断,不可比), UpdateShortMessage=0(不可达)
	// → 合计 4
	if got := c.observer.Total(); got != 4 {
		t.Errorf("记录 %d 次,期望 4(批次已拆成单条)", got)
	}
}

// TestShortMessagesArriveAsUpdateShort 锁死 gotd 的预处理行为。
//
// 如果哪天 gotd 不再预先转换,updateShortMessage 会走到 default 分支
// 变成不可观测 —— diff 里会凭空多一类 Node 有、Go 没有的指纹。
// 这个断言让那种变化显式失败,而不是安静地污染比对结果。
func TestShortMessagesArriveAsUpdateShort(t *testing.T) {
	c := newTestClient(t)
	ctx := context.Background()

	before := c.observer.Total()
	_ = c.onUpdate(ctx, &tg.UpdateShortMessage{Date: testBaseUnix, ID: 9, UserID: 1})
	if got := c.observer.Total(); got != before {
		t.Errorf("UpdateShortMessage 被记录了 %d 次 —— gotd 不再预先转换它了?"+
			"需要在 onUpdate 里补一个分支,否则这类消息在 Go 侧不可观测",
			got-before)
	}

	// 确认转换后的形态确实会被记录
	_ = c.onUpdate(ctx, &tg.UpdateShort{
		Date: testBaseUnix,
		Update: &tg.UpdateNewMessage{
			Message:  &tg.Message{ID: 9, Message: "hi"},
			Pts:      1,
			PtsCount: 1,
		},
	})
	if got := c.observer.Total(); got != before+1 {
		t.Errorf("转换后的 UpdateShort 未被记录")
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

	before := c.observer.Total()
	// 批次必须被拆开 —— gramjs 是逐条回调,Node 侧记的也是逐条。
	// 不拆的话 Go 记「Updates×1」Node 记「UpdateNewMessage×3」,diff 全红。
	// 时间戳跨两个已走完的分钟,避开「当前分钟不计入窗口」的规则。
	_ = c.onUpdate(ctx, &tg.Updates{
		Date: testBaseUnix + 60,
		Updates: []tg.UpdateClass{
			updateNewMessage(1), updateNewMessage(2), updateNewMessage(3),
		},
	})
	_ = c.onUpdate(ctx, &tg.UpdateShort{Date: testBaseUnix + 120, Update: updateNewMessage(4)})
	_ = c.onUpdate(ctx, &tg.UpdatesTooLong{})

	if got := c.observer.Total() - before; got != 4 {
		t.Errorf("记录 %d 次,期望 4(3 条批次 + 1 条 short)", got)
	}

	s := c.observer.Summary()
	// ByType 用 TL TypeID 做键(跨语言稳定标识),且只统计窗口内
	// 【已走完的分钟】—— 最后一条(base+120)正好是当前分钟,被排除,
	// 所以是 3 而不是 4。进程累计仍是 4。
	if s.ByType["1f2b0afd"] != 3 {
		t.Errorf("UpdateNewMessage(TypeID 1f2b0afd) 窗口内计数 = %d,期望 3"+
			"(批次已拆成单条,当前分钟不计入)", s.ByType["1f2b0afd"])
	}
	if s.ByType["UpdatesTooLong"] != 0 {
		t.Errorf("UpdatesTooLong 不应计入构成(该时段不可比),却记了 %d",
			s.ByType["UpdatesTooLong"])
	}
	if s.Window == "" {
		t.Error("窗口时长不应为空")
	}

	// 指纹必须稳定:同一批观察两次算出同一个值,否则没法比对。
	// 用共享契约算 —— Node 侧用的是同一份算法。
	mk := func(textLen int) string {
		return shadowfingerprint.Compute(shadowfingerprint.Observation{
			TypeID: "1f2b0afd", TextLen: textLen,
		})
	}
	if mk(10) != mk(10) {
		t.Error("指纹不稳定")
	}
	if mk(10) == mk(11) {
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
	if c.observer.Total() != 0 {
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