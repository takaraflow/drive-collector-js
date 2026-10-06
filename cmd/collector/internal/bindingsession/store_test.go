package bindingsession

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// newTest 起一个 miniredis —— 会话存储是纯 KV 读写,假的 Redis 足够真。
func newTest(t *testing.T) *Store {
	t.Helper()
	mr := miniredis.RunT(t)
	return NewStore(redis.NewClient(&redis.Options{Addr: mr.Addr()}))
}

func TestStartGetRoundtrip(t *testing.T) {
	ctx := context.Background()
	s := newTest(t)

	if err := s.Start(ctx, "42", "MEGA:WAIT_EMAIL", map[string]string{"user": "a@b"}); err != nil {
		t.Fatalf("start: %v", err)
	}
	sess, err := s.Get(ctx, "42")
	if err != nil || sess == nil {
		t.Fatalf("get: %v %v", sess, err)
	}
	if sess.CurrentStep != "MEGA:WAIT_EMAIL" || sess.Data["user"] != "a@b" {
		t.Fatalf("往返不一致: %+v", sess)
	}
	if sess.UserID != "42" {
		t.Fatalf("user_id 应回填: %+v", sess)
	}
}

func TestGetMissing(t *testing.T) {
	sess, err := newTest(t).Get(context.Background(), "nobody")
	if err != nil || sess != nil {
		t.Fatalf("没有会话应返回 (nil,nil): %v %v", sess, err)
	}
}

func TestUpdateMerges(t *testing.T) {
	ctx := context.Background()
	s := newTest(t)

	_ = s.Start(ctx, "42", "MEGA:WAIT_EMAIL", map[string]string{"user": "a@b"})
	if err := s.Update(ctx, "42", "MEGA:WAIT_PASS", map[string]string{"x": "1"}); err != nil {
		t.Fatalf("update: %v", err)
	}
	sess, _ := s.Get(ctx, "42")
	if sess.Data["user"] != "a@b" || sess.Data["x"] != "1" || sess.CurrentStep != "MEGA:WAIT_PASS" {
		t.Fatalf("update 应合并不覆盖: %+v", sess)
	}
}

func TestUpdateWithoutSession(t *testing.T) {
	// 没有会话时 Update 必须报错而不是静默建一个 —— 静默会让
	// 过期会话「复活」成半截流程。
	if err := newTest(t).Update(context.Background(), "42", "X:Y", nil); err == nil {
		t.Fatal("无会话 update 应报错")
	}
}

func TestClear(t *testing.T) {
	ctx := context.Background()
	s := newTest(t)

	_ = s.Start(ctx, "42", "A:B", nil)
	if err := s.Clear(ctx, "42"); err != nil {
		t.Fatalf("clear: %v", err)
	}
	sess, err := s.Get(ctx, "42")
	if err != nil || sess != nil {
		t.Fatalf("clear 后应读不到: %v %v", sess, err)
	}
}

func TestKeyMatchesJS(t *testing.T) {
	// key 与 JS 侧 CACHE_KEYS.session 一致 —— 切换期两边要能互读。
	if key("42") != "session:42" {
		t.Fatalf("key 格式与 JS 不一致: %q", key("42"))
	}
}
