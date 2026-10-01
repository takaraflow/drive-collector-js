package leader

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// TestListActiveInstances 用真实 Redis 语义(SCAN / GET)验证活跃实例筛选。
// 之前手写 RESP mock 反复出错 —— 用 miniredis,别再和协议解析器缠斗。
func TestListActiveInstances(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	fresh := map[string]any{
		"id": "inst-1", "url": "http://a", "directUrl": "http://a",
		"lastHeartbeat": time.Now().UnixMilli(),
	}
	stale := map[string]any{
		"id": "inst-stale", "url": "http://b", "directUrl": "http://b",
		"lastHeartbeat": time.Now().Add(-10 * time.Minute).UnixMilli(),
	}
	noHeartbeat := map[string]any{"id": "inst-nohb", "url": "http://c", "directUrl": "http://c"}

	for k, v := range map[string]map[string]any{
		"instance:inst-1":     fresh,
		"instance:inst-stale": stale,
		"instance:inst-nohb":  noHeartbeat,
	} {
		b, _ := json.Marshal(v)
		mr.Set(k, string(b))
	}
	// 非 instance: 前缀的 key 必须被 SCAN 过滤掉
	mr.Set("other:thing", "{}")

	got, err := listActiveInstances(ctx, client, instanceTimeoutMs)
	if err != nil {
		t.Fatalf("listActiveInstances: %v", err)
	}

	if len(got) != 1 {
		t.Fatalf("活跃实例数 = %d(%v),期望 1 —— 过期和无心跳的都必须被过滤", len(got), got)
	}
	if got[0].ID != "inst-1" {
		t.Errorf("返回的实例 = %q,期望 inst-1", got[0].ID)
	}
	if got[0].DirectURL != "http://a" {
		t.Errorf("directUrl = %q", got[0].DirectURL)
	}
}

// TestFullLeaderResolution 走完整链路:锁 → 活跃列表 → leader 地址。
// 这就是 BaseURL 在生产里做的事,只是这次 Redis 是真的。
func TestFullLeaderResolution(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	mr.Set(LockKey, `{"instanceId":"inst-1","version":2}`)
	b, _ := json.Marshal(map[string]any{
		"id": "inst-1", "url": "http://fallback", "directUrl": "http://leader:7860",
		"lastHeartbeat": time.Now().UnixMilli(),
	})
	mr.Set("instance:inst-1", string(b))

	r := &Resolver{
		LockGetter: func(ctx context.Context, key string) ([]byte, error) {
			return client.Get(ctx, key).Bytes()
		},
		ActiveLister: func(ctx context.Context) ([]Instance, error) {
			return listActiveInstances(ctx, client, instanceTimeoutMs)
		},
	}

	got, err := r.BaseURL(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://leader:7860" {
		t.Errorf("BaseURL = %q,期望 http://leader:7860", got)
	}
}

// TestLeaderDiesMidFlight 持锁实例心跳过期后,必须报「无 leader」而不是
// 继续把任务转发给一个已经死掉的实例 —— 那会静默丢任务。
func TestLeaderDiesMidFlight(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	mr.Set(LockKey, `{"instanceId":"inst-1"}`)
	b, _ := json.Marshal(map[string]any{
		"id": "inst-1", "directUrl": "http://leader:7860",
		"lastHeartbeat": time.Now().Add(-10 * time.Minute).UnixMilli(),
	})
	mr.Set("instance:inst-1", string(b))

	r := &Resolver{
		LockGetter: func(ctx context.Context, key string) ([]byte, error) {
			return client.Get(ctx, key).Bytes()
		},
		ActiveLister: func(ctx context.Context) ([]Instance, error) {
			return listActiveInstances(ctx, client, instanceTimeoutMs)
		},
	}

	got, err := r.BaseURL(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got != "" {
		t.Errorf("心跳过期的 leader 不该被选中,却返回了 %q", got)
	}
}