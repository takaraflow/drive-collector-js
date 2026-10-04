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
//
// 这是生产事故的回归测试:Register 里写了
//
//	ticker := time.NewTicker(15 * time.Second)
//	defer ticker.Stop()        // ← 函数一返回就停
//	go func(){ <-ticker.C ... }()
//	return nil                 // ← 到这里 ticker 已经死了
//
// ticker 被 defer 停掉后,那个 channel 再也不会发信号,心跳 goroutine
// 永远阻塞在 <-ticker.C 上。于是 registerOnce 一辈子只跑启动那一次,
// 实例键 90 秒后过期消失 —— 而 lock:telegram_client 仍在续租。
//
// 症状极难发现:服务看起来正常(锁在续),但 instance:<id> 不见了。
// 这正是生产上观察到的现象。
//
// 修法:ticker 必须由 goroutine 自己拥有并在退出时 Stop,
// 不能挂在 Register 上 defer —— Register 是【非阻塞】的。
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
//
// 光看「键存在」还不够:如果每次写的是同一份旧 payload,
// Node 会因为 lastHeartbeat 太旧而判定实例已下线,进而抢占它的锁。
func TestRegisterHeartbeatRefreshesTimestamp(t *testing.T) {
	c, mr := newTest(t, "go-1", "https://go.example.com")
	c.heartbeatEvery = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 假时钟必须用原子量:心跳 goroutine 在另一条协程上读它,
	// 直接改一个普通变量会被 -race 判定为数据竞争。
	// (生产里 c.now 构造后就不再写,不存在这个问题。)
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
//
// 这是「非阻塞 Register」的另一面:Register 返回后调用方继续跑,
// 心跳必须一直活着 —— 而不是随 Register 的返回一起结束。
func TestRegisterDoesNotDeregisterWhileCtxAlive(t *testing.T) {
	c, mr := newTest(t, "go-1", "https://go.example.com")
	c.heartbeatEvery = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := c.Register(ctx); err != nil {
		t.Fatal(err)
	}

	// 模拟「调用方继续干别的事」——睡够好几轮心跳周期。
	mr.FastForward(instanceTimeout * 2)
	time.Sleep(100 * time.Millisecond)

	if !mr.Exists("instance:go-1") {
		t.Error("ctx 还活着,实例键不该消失")
	}
}
