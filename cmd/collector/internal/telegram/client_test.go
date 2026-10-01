package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/gotd/td/session"
	"github.com/gotd/td/tg"

	"github.com/youngsx/drive-collector/cmd/collector/internal/tgsession"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func loadSession(t *testing.T) *tgsession.Session {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "..", "testdata", "tgsession_vectors.json"))
	if err != nil {
		t.Fatalf("读向量失败: %v", err)
	}
	var v struct {
		Cases []struct {
			S string `json:"s"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	s, err := tgsession.Parse(v.Cases[0].S)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func newTestClient(t *testing.T, h MessageHandler) *Client {
	t.Helper()
	c, err := New(Config{
		APIID: 12345, APIHash: "0123456789abcdef0123456789abcdef",
		Session: loadSession(t), Handler: h, Log: quiet(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// TestClassifyMediaGroup 媒体组必须被识别出来。
//
// 用户连发 10 张图会走 updateShortMessage 包装的 grouped_id,
// 不识别的话会被当成 10 条独立消息 —— 每个都建一个任务,
// 用户看到的就是「我的相册被拆成 10 个任务」。
func TestClassifyMediaGroup(t *testing.T) {
	// 必须设 flag 17 —— GetGroupedID 靠它判断字段是否有效,
	// 直接赋值字段不设 flag 的话 getter 返回 0。
	msg := &tg.Message{ID: 1, GroupedID: 987654}
	msg.Flags.Set(17)
	if got := classify(&tg.UpdateNewMessage{Message: msg}); got != KindMediaGroup {
		t.Errorf("有 grouped_id 应识别为媒体组,得到 %s", got)
	}

	plain := &tg.Message{ID: 2}
	if got := classify(&tg.UpdateNewMessage{Message: plain}); got != KindNewMessage {
		t.Errorf("无 grouped_id 应是普通消息,得到 %s", got)
	}
}

// TestClassifyCoversEmptyMessage 空消息不该 panic。
func TestClassifyCoversEmptyMessage(t *testing.T) {
	if got := classify(&tg.UpdateNewMessage{Message: &tg.MessageEmpty{ID: 1}}); got != KindNewMessage {
		t.Errorf("空消息的分类 = %s", got)
	}
}

func TestClassifyOtherKinds(t *testing.T) {
	cases := []struct {
		u    tg.UpdateClass
		want Kind
	}{
		{&tg.UpdateEditMessage{Message: &tg.MessageEmpty{ID: 1}}, KindEditMessage},
		{&tg.UpdateEditChannelMessage{Message: &tg.MessageEmpty{ID: 1}}, KindEditMessage},
		{&tg.UpdateBotCallbackQuery{QueryID: 1}, KindCallbackQuery},
		{&tg.UpdateDeleteMessages{Messages: []int{1}}, KindDeleteMessage},
		{&tg.UpdateUserTyping{UserID: 1}, KindOther},
	}
	for _, tc := range cases {
		if got := classify(tc.u); got != tc.want {
			t.Errorf("classify(%T) = %s,期望 %s", tc.u, got, tc.want)
		}
	}
}

// TestDispatchSplitsBatches 批次必须拆成单条。
//
// gotd 收 tg.Updates(打包),gramjs 是逐条回调。业务层按逐条处理,
// 不拆的话一次只能看到第一条。
func TestDispatchSplitsBatches(t *testing.T) {
	var mu sync.Mutex
	var got []Kind

	var h MessageHandler = func(_ context.Context, u Update) error {
		mu.Lock()
		got = append(got, u.Kind)
		mu.Unlock()
		return nil
	}
	c := newTestClient(t, h)

	dispatch := c.dispatch(h)
	dispatch(context.Background(), &tg.Updates{
		Date: 1700000000,
		Updates: []tg.UpdateClass{
			newMsg(1), newMsg(2), newMsg(3),
		},
	})

	if len(got) != 3 {
		t.Fatalf("收到 %d 条,期望 3(批次必须拆开)", len(got))
	}
	for _, k := range got {
		if k != KindNewMessage {
			t.Errorf("分类 = %s", k)
		}
	}
}

// TestHandlerErrorDoesNotBreakStream handler 出错不能中断 update 流。
//
// 影子验证最怕「流出现空洞导致比对失真」—— 而 gotd 在 handler
// 返回 error 时会断开重连,那正好制造空洞。
func TestHandlerErrorDoesNotBreakStream(t *testing.T) {
	var h MessageHandler = func(context.Context, Update) error {
		return errors.New("业务错误")
	}
	c := newTestClient(t, h)
	dispatch := c.dispatch(h)

	// 第一条会报错,第二条仍应被处理 —— 不重连、不中断
	for i := 0; i < 3; i++ {
		err := dispatch(context.Background(), &tg.Updates{
			Date:    1700000000,
			Updates: []tg.UpdateClass{newMsg(i)},
		})
		if err != nil {
			t.Errorf("第 %d 轮 dispatch 返回了 %v —— 会导致 gotd 断开重连", i+1, err)
		}
	}
}

// TestNilHandlerIsSafe 没注入 handler 时静默跳过。
func TestNilHandlerIsSafe(t *testing.T) {
	c := newTestClient(t, nil)
	if err := c.dispatch(nil)(context.Background(), &tg.Updates{
		Date: 1, Updates: []tg.UpdateClass{newMsg(1)},
	}); err != nil {
		t.Errorf("nil handler 不该报错:%v", err)
	}
}

// TestUnrecognizedContainerDoesNotFail 未知容器只记日志。
func TestUnrecognizedContainerDoesNotFail(t *testing.T) {
	c := newTestClient(t, func(context.Context, Update) error { return nil })
	if err := c.dispatch(nil)(context.Background(), &tg.UpdatesTooLong{}); err != nil {
		t.Errorf("UpdatesTooLong 不该报错:%v", err)
	}
}

func newMsg(id int) *tg.UpdateNewMessage {
	return &tg.UpdateNewMessage{Message: &tg.Message{ID: id}, Pts: id}
}

// TestSessionStorageIsReadableByGotd session 必须能被 gotd 的 Loader 解析。
//
// AuthKeyID 错了的话 gotd 会在恢复连接时报 "corrupted key" ——
// 而那只有真连一次 Telegram 才会暴露。
func TestSessionStorageIsReadableByGotd(t *testing.T) {
	sess := loadSession(t)
	st, err := newSessionStorage(sess)
	if err != nil {
		t.Fatal(err)
	}
	data, err := (&session.Loader{Storage: st}).Load(context.Background())
	if err != nil {
		t.Fatalf("gotd Loader 解析失败: %v", err)
	}
	if len(data.AuthKeyID) != 8 {
		t.Errorf("AuthKeyID 长度 = %d,期望 8", len(data.AuthKeyID))
	}
	if data.AuthKeyID == nil || data.AuthKeyID[0] != sess.AuthKeyID()[0] {
		t.Errorf("AuthKeyID 不匹配")
	}
}

// TestStoreSessionIsNoOp session 不能被写回 —— 那是 Node 的。
func TestStoreSessionIsNoOp(t *testing.T) {
	sess := loadSession(t)
	st, err := newSessionStorage(sess)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := st.LoadSession(context.Background())
	if err := st.StoreSession(context.Background(), []byte("garbage")); err != nil {
		t.Fatal(err)
	}
	after, _ := st.LoadSession(context.Background())
	if string(before) != string(after) {
		t.Error("StoreSession 改动了 session —— 铁律 3 被违反")
	}
}

// TestNewRejectsIncompleteConfig 配置不全必须硬失败。
func TestNewRejectsIncompleteConfig(t *testing.T) {
	if _, err := New(Config{Session: loadSession(t), Log: quiet()}); err == nil {
		t.Error("缺 API_ID/API_HASH 应报错")
	}
	if _, err := New(Config{APIID: 1, APIHash: "h", Log: quiet()}); err == nil {
		t.Error("缺 session 应报错")
	}
}

// TestNewDoesNotConnect 构造不该发起连接 —— 影子容器不该一启动就占用账号。
func TestNewDoesNotConnect(t *testing.T) {
	c := newTestClient(t, nil)
	if c.SelfID() != 0 {
		t.Errorf("未连接时 SelfID 应为 0,得到 %d", c.SelfID())
	}
}

func TestProgressBar(t *testing.T) {
	cases := []struct {
		ratio float64
		want  string
	}{
		{0, "[" + strings.Repeat("░", 4) + "]"},
		{1, "[" + strings.Repeat("█", 4) + "]"},
		{0.5, "[██░░]"},
		{-1, "[" + strings.Repeat("░", 4) + "]"}, // 越界夹紧
		{5, "[" + strings.Repeat("█", 4) + "]"},  // 越界夹紧
	}
	for _, tc := range cases {
		if got := progressBar(tc.ratio, 4); got != tc.want {
			t.Errorf("progressBar(%v) = %q,期望 %q", tc.ratio, got, tc.want)
		}
	}
}

// TestRandIDIsDistinct 连续生成的 ID 必须不同 ——
// 撞了会导致 Telegram 丢弃后续消息(去重)。
func TestRandIDIsDistinct(t *testing.T) {
	seen := map[int64]bool{}
	for i := 0; i < 1000; i++ {
		id := randomID()
		if seen[id] {
			t.Fatalf("第 %d 次生成了重复的 RandomID: %d", i, id)
		}
		seen[id] = true
	}
}
