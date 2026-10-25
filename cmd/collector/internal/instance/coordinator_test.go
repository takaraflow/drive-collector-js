package instance

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func newTest(t *testing.T, id, url string) (*Coordinator, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	c := NewCoordinator(redis.NewClient(&redis.Options{Addr: mr.Addr()}), id, url, quiet())
	return c, mr
}

// TestLockValueMatchesJSFormat 锁的 JSON 字段名必须与 JS 侧逐字一致。
//
// JS 用 leaseId 做 CAS 比较基准 —— 字段名或结构不同,续租永远不命中,
// 两边会互相认为对方持锁,然后互相把对方踢下线。
func TestLockValueMatchesJSFormat(t *testing.T) {
	c, mr := newTest(t, "go-1", "https://go.example.com")
	ctx := context.Background()

	if err := c.Register(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AcquireTelegramLock(ctx); err != nil {
		t.Fatal(err)
	}

	raw, err := mr.Get("lock:telegram_client")
	if err != nil {
		t.Fatal(err)
	}

	var m map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"instanceId", "acquiredAt", "ttl", "leaseId"} {
		if _, ok := m[field]; !ok {
			t.Errorf("锁值缺少 JS 侧必需字段 %q —— Node 读不到会认为锁无效", field)
		}
	}
	// TTL 必须是秒(90),不是毫秒(90000)—— JS 按秒解释。
	if got := int64(m["ttl"].(float64)); got != 90 {
		t.Errorf("ttl = %d,期望 90(秒)。写成毫秒会让 Node 认为锁已过期", got)
	}
	// Redis 自身的 EX 也要是秒
	ttl := mr.TTL("lock:telegram_client")
	if ttl != 90*time.Second {
		t.Errorf("Redis TTL = %v,期望 90s", ttl)
	}
}

// TestRegisterShape LB 按 instance.url 转发 —— 这就是 Go 接管的机制。
func TestRegisterShape(t *testing.T) {
	c, mr := newTest(t, "go-1", "https://go.example.com")
	ctx := context.Background()
	if err := c.Register(ctx); err != nil {
		t.Fatal(err)
	}

	raw, _ := mr.Get("instance:go-1")
	var info InstanceInfo
	if err := json.Unmarshal([]byte(raw), &info); err != nil {
		t.Fatal(err)
	}
	if info.ID != "go-1" {
		t.Errorf("id = %q", info.ID)
	}
	if info.URL != "https://go.example.com" {
		t.Errorf("url = %q —— LB 靠它决定转发目标", info.URL)
	}
	if info.Status != "active" {
		t.Errorf("status = %q,期望 active", info.Status)
	}
	if info.LastHeartbeat == 0 {
		t.Error("缺 lastHeartbeat —— Node 靠它判断本实例是否活跃")
	}
}

// TestRenewKeepsSameLease 续租必须复用同一个 leaseId。
//
// 这是 Node 的行为:换掉的话 Node 的续租 CAS 会永远不命中。
func TestRenewKeepsSameLease(t *testing.T) {
	c, mr := newTest(t, "go-1", "https://go.example.com")
	ctx := context.Background()
	_ = c.Register(ctx)
	if _, err := c.AcquireTelegramLock(ctx); err != nil {
		t.Fatal(err)
	}

	raw1, _ := mr.Get("lock:telegram_client")
	var v1 LockValue
	_ = json.Unmarshal([]byte(raw1), &v1)

	if ok, err := c.RenewTelegramLock(ctx); err != nil || !ok {
		t.Fatalf("续租失败: ok=%v err=%v", ok, err)
	}

	raw2, _ := mr.Get("lock:telegram_client")
	var v2 LockValue
	_ = json.Unmarshal([]byte(raw2), &v2)

	if v1.LeaseID != v2.LeaseID {
		t.Errorf("续租换了 leaseId:\n  前: %s\n  后: %s\n"+
			"改了会让 Node 的 CAS 续租永远不命中", v1.LeaseID, v2.LeaseID)
	}
	if v2.AcquiredAt < v1.AcquiredAt {
		t.Error("acquiredAt 倒退了")
	}
}

// TestSecondInstanceCannotStealActiveLock 这是防双实例并发处理的核心。
func TestSecondInstanceCannotStealActiveLock(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	first := NewCoordinator(rdb, "node-1", "https://node.example.com", quiet())
	second := NewCoordinator(rdb, "go-1", "https://go.example.com", quiet())

	_ = first.Register(ctx)
	_ = second.Register(ctx)

	ok, err := first.AcquireTelegramLock(ctx)
	if err != nil || !ok {
		t.Fatalf("第一个实例应拿到锁: ok=%v err=%v", ok, err)
	}

	// 第二个不能抢 —— 第一个还活跃
	ok2, err := second.AcquireTelegramLock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if ok2 {
		t.Error("活跃实例的锁被抢走了 —— 会导致双实例同时处理消息")
	}
}

// TestStealLockFromDeadInstance 持有者下线后允许抢占。
//
// 这正是「切流量」的机制:停掉 Node,Go 才能接手。
func TestStealLockFromDeadInstance(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	old := NewCoordinator(rdb, "node-1", "https://node.example.com", quiet())
	_ = old.Register(ctx)
	if ok, _ := old.AcquireTelegramLock(ctx); !ok {
		t.Fatal("旧实例应拿到锁")
	}

	// 旧实例下线:注销 + 心跳过期
	old.deregister()
	mr.FastForward(60 * time.Second) // 超过 instanceTimeout(45s)

	newer := NewCoordinator(rdb, "go-1", "https://go.example.com", quiet())
	_ = newer.Register(ctx)

	ok, err := newer.AcquireTelegramLock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Error("原持有者已下线,新实例应能抢占 —— 否则永远切不过去")
	}

	raw, _ := mr.Get("lock:telegram_client")
	var lv LockValue
	_ = json.Unmarshal([]byte(raw), &lv)
	if lv.InstanceID != "go-1" {
		t.Errorf("锁的持有者 = %q,期望 go-1", lv.InstanceID)
	}
}

// TestExpiredLockIsStealable 锁过期后允许重取 ——
// 与 JS 侧 (now - acquiredAt) < ttl*1000 的判断一致。
func TestExpiredLockIsStealable(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	old := NewCoordinator(rdb, "node-1", "https://node.example.com", quiet())
	_ = old.Register(ctx)
	if ok, _ := old.AcquireTelegramLock(ctx); !ok {
		t.Fatal("旧实例应拿到锁")
	}
	// 只让心跳过期,Redis 键还在
	mr.Del("instance:node-1")

	newer := NewCoordinator(rdb, "go-1", "https://go.example.com", quiet())
	_ = newer.Register(ctx)
	// 快进超过锁 TTL,让 acquiredAt 判定失效
	time.Sleep(10 * time.Millisecond)
	c := newer
	// 直接构造一个「已过期」的锁值来测判定边界
	expired := &LockValue{
		InstanceID: "node-1",
		AcquiredAt: c.now().Add(-200 * time.Second).UnixMilli(),
		TTL:        90,
		LeaseID:    "old",
	}
	payload, _ := json.Marshal(expired)
	mr.Set("lock:telegram_client", string(payload))

	ok, err := newer.AcquireTelegramLock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !ok {
		t.Error("过期锁应可被抢占")
	}
}

// TestCorruptedLockDoesNotDeadlock 锁值损坏时视作不存在,而不是卡死。
func TestCorruptedLockDoesNotDeadlock(t *testing.T) {
	c, mr := newTest(t, "go-1", "https://go.example.com")
	ctx := context.Background()
	mr.Set("lock:telegram_client", "not-json-at-all")

	done := make(chan bool, 1)
	go func() {
		ok, _ := c.AcquireTelegramLock(ctx)
		done <- ok
	}()

	select {
	case ok := <-done:
		if !ok {
			t.Error("损坏的锁应被视作不存在并重建")
		}
	case <-time.After(3 * time.Second):
		t.Error("损坏的锁导致死锁")
	}
}

// TestNilRedisFailsCleanly 没配 Redis 时明确报错,不是静默。
func TestNilRedisFailsCleanly(t *testing.T) {
	c := NewCoordinator(nil, "go-1", "https://go.example.com", quiet())
	if err := c.Register(context.Background()); err == nil {
		t.Error("无 Redis 应报错")
	}
	if _, err := c.AcquireTelegramLock(context.Background()); err == nil {
		t.Error("无 Redis 时抢锁应报错")
	}
}

// TestHasLockReportsOwnership HasTelegramLock 必须在别人持锁时返回 false。
func TestHasLockReportsOwnership(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	a := NewCoordinator(rdb, "node-1", "https://node.example.com", quiet())
	b := NewCoordinator(rdb, "go-1", "https://go.example.com", quiet())
	_ = a.Register(ctx)
	_ = b.Register(ctx)
	_, _ = a.AcquireTelegramLock(ctx)

	heldByA, _ := a.HasTelegramLock(ctx)
	heldByB, _ := b.HasTelegramLock(ctx)
	if !heldByA {
		t.Error("A 应认为自己持锁")
	}
	if heldByB {
		t.Error("B 不该认为自己持锁")
	}
}

// TestRegisterKeepsHeartbeatAlive 心跳必须【持续】刷新实例键。
func TestRegisterKeepsHeartbeatAlive(t *testing.T) {
	c, mr := newTest(t, "go-1", "https://go.example.com")
	c.heartbeatEvery = 5 * time.Millisecond // 别让测试等 15 秒
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := c.Register(ctx); err != nil {
		t.Fatal(err)
	}

	const key = "instance:go-1"
	// 先确认启动时写进去了
	if !mr.Exists(key) {
		t.Fatalf("注册后 %s 应存在", key)
	}

	// 让键过期。心跳如果活着,会把它写回来。
	mr.FastForward(instanceTimeout * 2)
	if mr.Exists(key) {
		t.Fatal("测试前提有误:键应该已过期")
	}

	// 等几轮心跳周期。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if mr.Exists(key) {
			return // 心跳把键写回来了 —— 正确
		}
		time.Sleep(5 * time.Millisecond)
	}

	t.Fatalf("心跳已死:实例键 %s 过期后再也没被写回。"+
		"registerOnce 只会在启动时跑一次 —— 检查 ticker 是不是被 defer Stop 了", key)
}

// TestRegisterHeartbeatRefreshesTimestamp 心跳要更新 lastHeartbeat。
func TestRegisterHeartbeatRefreshesTimestamp(t *testing.T) {
	c, mr := newTest(t, "go-1", "https://go.example.com")
	c.heartbeatEvery = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var clock atomic.Int64
	clock.Store(time.Unix(1791100000, 0).UnixNano())
	c.now = func() time.Time { return time.Unix(0, clock.Load()) }

	if err := c.Register(ctx); err != nil {
		t.Fatal(err)
	}

	read := func() InstanceInfo {
		raw, err := mr.Get("instance:go-1")
		if err != nil {
			t.Fatalf("读实例键失败:%v", err)
		}
		var info InstanceInfo
		if err := json.Unmarshal([]byte(raw), &info); err != nil {
			t.Fatal(err)
		}
		return info
	}

	first := read().LastHeartbeat

	// 推进时钟,等心跳跑一轮。
	clock.Store(time.Unix(1791100000+30, 0).UnixNano())
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if read().LastHeartbeat > first {
			return // 心跳推进了时间戳 —— 正确
		}
		time.Sleep(5 * time.Millisecond)
	}

	t.Errorf("心跳没刷新 lastHeartbeat(仍是 %d)—— "+
		"Node 会据此判定本实例已下线并抢占锁", first)
}

// TestRegisterDoesNotDeregisterWhileCtxAlive 只要 ctx 没结束,实例键就得在。
func TestRegisterDoesNotDeregisterWhileCtxAlive(t *testing.T) {
	c, mr := newTest(t, "go-1", "https://go.example.com")
	c.heartbeatEvery = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := c.Register(ctx); err != nil {
		t.Fatal(err)
	}

	mr.FastForward(instanceTimeout * 2)
	time.Sleep(100 * time.Millisecond)

	if !mr.Exists("instance:go-1") {
		t.Error("ctx 还活着,实例键不该消失")
	}
}

// TestReleaseTelegramLock 主动释放锁与防误删他人锁
func TestReleaseTelegramLock(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	node1 := NewCoordinator(rdb, "node-1", "https://node.example.com", quiet())
	node2 := NewCoordinator(rdb, "node-2", "https://node.example.com", quiet())
	_ = node1.Register(ctx)
	_ = node2.Register(ctx)

	ok, err := node1.AcquireTelegramLock(ctx)
	if err != nil || !ok {
		t.Fatalf("node-1 应该获取锁: %v", err)
	}

	// node-2 尝试释放 node-1 的锁，应该被拒绝且锁仍在
	if err := node2.ReleaseTelegramLock(ctx); err != nil {
		t.Fatal(err)
	}
	if !mr.Exists("lock:telegram_client") {
		t.Error("node-2 误删了 node-1 的锁!")
	}

	// node-1 正常主动释放锁
	if err := node1.ReleaseTelegramLock(ctx); err != nil {
		t.Fatal(err)
	}
	if mr.Exists("lock:telegram_client") {
		t.Error("node-1 释放后锁应已被删除")
	}

	// 现在 node-2 应当可以立即获取锁，无需等待 90 秒 TTL
	ok2, err := node2.AcquireTelegramLock(ctx)
	if err != nil || !ok2 {
		t.Errorf("node-2 应该能立即获取已释放的锁: %v", err)
	}
}

// TestGetTelegramLockHolder 读取锁持有者
func TestGetTelegramLockHolder(t *testing.T) {
	c, _ := newTest(t, "worker-1", "https://w1.example.com")
	ctx := context.Background()

	// 锁不存在时
	holder, err := c.GetTelegramLockHolder(ctx)
	if err != nil || holder != "" {
		t.Errorf("锁不存在时 holder 期望空, 实际: %q, err: %v", holder, err)
	}

	// 获取锁后
	_, _ = c.AcquireTelegramLock(ctx)
	holder, err = c.GetTelegramLockHolder(ctx)
	if err != nil || holder != "worker-1" {
		t.Errorf("holder 期望 worker-1, 实际: %q", holder)
	}
}

// TestActiveTaskCountHeartbeat 测试负载指标 activeTaskCount 上报
func TestActiveTaskCountHeartbeat(t *testing.T) {
	c, mr := newTest(t, "worker-1", "https://w1.example.com")
	ctx := context.Background()

	counter := 3
	c.RegisterActiveTaskCounter(func() int {
		return counter
	})

	if err := c.Register(ctx); err != nil {
		t.Fatal(err)
	}

	raw, err := mr.Get("instance:worker-1")
	if err != nil {
		t.Fatal(err)
	}

	var info InstanceInfo
	if err := json.Unmarshal([]byte(raw), &info); err != nil {
		t.Fatal(err)
	}
	if info.ActiveTaskCount != 3 {
		t.Errorf("activeTaskCount 期望 3, 实际 %d", info.ActiveTaskCount)
	}
}

// TestGenericDistributedLock 测试通用分布式锁和任务锁
func TestGenericDistributedLock(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	w1 := NewCoordinator(rdb, "worker-1", "https://w1.example.com", quiet())
	w2 := NewCoordinator(rdb, "worker-2", "https://w2.example.com", quiet())
	_ = w1.Register(ctx)
	_ = w2.Register(ctx)

	taskID := "task-abc-123"

	// worker-1 获取任务锁
	leaseID1, acquired, err := w1.AcquireTaskLock(ctx, taskID, 60*time.Second)
	if err != nil || !acquired || leaseID1 == "" {
		t.Fatalf("w1 应成功获取任务锁: lease=%s, ok=%v, err=%v", leaseID1, acquired, err)
	}

	// worker-2 尝试获取同一任务锁应失败
	_, acquired2, err := w2.AcquireTaskLock(ctx, taskID, 60*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if acquired2 {
		t.Error("同一任务锁不应被两个 worker 同时获取")
	}

	// worker-1 续租任务锁
	renewed, err := w1.RenewLock(ctx, "task:"+taskID, leaseID1, 60*time.Second)
	if err != nil || !renewed {
		t.Errorf("w1 续租任务锁失败: renewed=%v, err=%v", renewed, err)
	}

	// worker-2 无法释放 worker-1 的锁
	_ = w2.ReleaseTaskLock(ctx, taskID, "wrong-lease")
	if !mr.Exists("lock:task:" + taskID) {
		t.Error("w2 不应能误删 w1 的任务锁")
	}

	// worker-1 正常释放任务锁
	if err := w1.ReleaseTaskLock(ctx, taskID, leaseID1); err != nil {
		t.Fatal(err)
	}
	if mr.Exists("lock:task:" + taskID) {
		t.Error("w1 释放后任务锁应已被删除")
	}
}

// TestClusterLeaderAndCleanup 测试集群 Leader 选举与过期实例清理
func TestClusterLeaderAndCleanup(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	nodeA := NewCoordinator(rdb, "instance-a", "https://a.example.com", quiet())
	nodeB := NewCoordinator(rdb, "instance-b", "https://b.example.com", quiet())
	_ = nodeA.Register(ctx)
	_ = nodeB.Register(ctx)

	// 按照字典序最小原则，instance-a 是集群 Leader
	isLeaderA, err := nodeA.IsClusterLeader(ctx)
	if err != nil || !isLeaderA {
		t.Errorf("nodeA 应该是 Leader: %v", err)
	}
	isLeaderB, err := nodeB.IsClusterLeader(ctx)
	if err != nil || isLeaderB {
		t.Errorf("nodeB 不应是 Leader: %v", err)
	}

	// 模拟过期死节点 instance-z
	deadPayload, _ := json.Marshal(InstanceInfo{
		ID:            "instance-z",
		URL:           "https://z.example.com",
		LastHeartbeat: time.Now().Add(-5 * time.Minute).UnixMilli(),
		Status:        "active",
	})
	mr.Set("instance:instance-z", string(deadPayload))

	// 清理过期实例 (maxAge = 90s)
	cleaned, err := nodeA.CleanupExpiredInstances(ctx, 90*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if cleaned != 1 {
		t.Errorf("预期清理 1 个过期实例, 实际清理 %d 个", cleaned)
	}
	if mr.Exists("instance:instance-z") {
		t.Error("过期实例 instance-z 应该已被清除")
	}
	if !mr.Exists("instance:instance-a") || !mr.Exists("instance:instance-b") {
		t.Error("活跃实例不应被清除")
	}
}
