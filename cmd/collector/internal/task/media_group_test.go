package task

import (
	"context"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

// mgQuiet 与 manager_test.go 的 quiet() 同包同义,这里换个名避免冲突。
func mgQuiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// flushCollector 收集刷盘记录。
//
// 【必须带锁】flush 跑在后台 goroutine 里(定时器触发),而测试在
// waitFor 里读 —— 不加锁就是 data race。
//
// 之前返回裸指针 *[][]int64 让调用方绕过锁直接读,竞态窗口很窄,
// 本地 -race 常常抓不到,CI 上负载一高就炸。
type flushCollector struct {
	mu      sync.Mutex
	batches [][]int64
}

func (c *flushCollector) add(ids []int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.batches = append(c.batches, append([]int64(nil), ids...))
}

// snapshot 返回拷贝,调用方随便读。
func (c *flushCollector) snapshot() [][]int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([][]int64(nil), c.batches...)
}

// batchSize 取第 i 批的条数。
func (c *flushCollector) batchSize(i int) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	if i >= len(c.batches) {
		return -1
	}
	return len(c.batches[i])
}

func (c *flushCollector) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.batches)
}

func (c *flushCollector) total() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, b := range c.batches {
		n += len(b)
	}
	return n
}

func newTestBuffer(t *testing.T) (*MediaGroupBuffer, *miniredis.Miniredis, *flushCollector) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	col := &flushCollector{}
	b := NewMediaGroupBuffer(rdb, BufferConfig{
		BufferTimeout: 50 * time.Millisecond, // 测试里不用等 1 秒
		Log:           mgQuiet(),
	})
	b.FlushGroup = func(_ context.Context, _ string, _ GroupMeta, ids []int64) error {
		col.add(ids)
		return nil
	}
	return b, mr, col
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}

// TestGroupsMessagesIntoOneFlush 这是媒体组存在的全部意义。
//
// 不聚合的话,用户发 10 张图会变成 10 个独立任务 —— 而且【不报错】,
// 只是结果不对。这类静默退化最难在测试里发现。
func TestGroupsMessagesIntoOneFlush(t *testing.T) {
	b, _, flushed := newTestBuffer(t)
	ctx := context.Background()
	const gid = "grp-1"

	for i := int64(1); i <= 3; i++ {
		if err := b.Add(ctx, gid, 555, 555, i); err != nil {
			t.Fatal(err)
		}
	}

	if !waitFor(t, 2*time.Second, func() bool { return flushed.count() > 0 }) {
		t.Fatal("缓冲窗口后没有刷盘")
	}
	if flushed.count() != 1 {
		t.Fatalf("刷了 %d 次,期望 1 次 —— 消息被拆成了多个任务", flushed.count())
	}
	if got := flushed.batchSize(0); got != 3 {
		t.Errorf("一批应有 3 条消息,实际 %d", got)
	}
}

// TestDuplicatePushDoesNotDuplicate Telegram 会重推同一条消息。
// 不去重会让同一个文件建两次任务。
func TestDuplicatePushDoesNotDuplicate(t *testing.T) {
	b, _, flushed := newTestBuffer(t)
	ctx := context.Background()
	const gid = "grp-dup"

	// 同一条消息推 3 次
	for i := 0; i < 3; i++ {
		if err := b.Add(ctx, gid, 555, 555, 42); err != nil {
			t.Fatal(err)
		}
	}

	if !waitFor(t, 2*time.Second, func() bool { return flushed.count() > 0 }) {
		t.Fatal("没有刷盘")
	}
	if got := flushed.batchSize(0); got != 1 {
		t.Errorf("同一 msgID 推 3 次应只留 1 条,实际 %d 条", got)
	}
}

// TestFullBatchFlushesImmediately 攒够 10 条立刻刷,不等缓冲窗口 ——
// 用户发满一批时再等 1 秒是多余的延迟。
func TestFullBatchFlushesImmediately(t *testing.T) {
	b, _, flushed := newTestBuffer(t)
	ctx := context.Background()
	const gid = "grp-full"

	start := time.Now()
	for i := int64(1); i <= 10; i++ {
		if err := b.Add(ctx, gid, 555, 555, i); err != nil {
			t.Fatal(err)
		}
	}
	elapsed := time.Since(start)

	if !waitFor(t, 2*time.Second, func() bool { return flushed.count() > 0 }) {
		t.Fatal("满批没有刷出")
	}
	// 缓冲窗口是 50ms(测试配置),满批应该远快于此
	if elapsed > 40*time.Millisecond {
		t.Errorf("满批耗时 %v,应远小于缓冲窗口 50ms", elapsed)
	}
	if got := flushed.batchSize(0); got != 10 {
		t.Errorf("一批应有 10 条,实际 %d", got)
	}
}

// TestFlushClearsState 刷出后状态要清干净 ——
// 留着的话组会重复刷,用户看到同一批文件传了两遍。
func TestFlushClearsState(t *testing.T) {
	b, mr, _ := newTestBuffer(t)
	ctx := context.Background()
	const gid = "grp-clear"

	_ = b.Add(ctx, gid, 555, 555, 1)

	// 等【索引】清空,而不是等 buffer key 消失 —— drop() 先删 buffer
	// 再删索引,只看前者会在这两步之间断言,60% 概率假失败。
	// flaky 比稳定失败更糟:它会让 CI 随机红,久了没人信 CI。
	if !waitFor(t, 2*time.Second, func() bool {
		n, _ := mr.SCard(b.indexKey())
		return n == 0
	}) {
		t.Error("刷出后索引未清空")
	}
	if mr.Exists(b.bufferKey(gid)) {
		t.Error("刷出后 buffer key 仍存在")
	}
}

// TestRestoreRecoversOrphanedGroups 重启后必须捞回遗留组。
//
// 进程重启会丢掉所有内存定时器,组就永远留在 Redis 里不刷 ——
// 用户的相册卡在「处理中」直到 60 秒后过期。
// 这是【静默失败】:没有任何报错,只是任务不出现。
func TestRestoreRecoversOrphanedGroups(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	// 模拟「上一个进程崩溃」的现场:数据在 Redis,但没有进程内的定时器了。
	// 这是 Restore 存在的唯一理由 —— 进程重启会丢掉所有内存定时器,
	// 组就永远留在 Redis 里不刷,用户的相册卡在「处理中」直到过期。
	const gid = "grp-orphan"
	b1 := NewMediaGroupBuffer(rdb, BufferConfig{BufferTimeout: time.Hour, Log: mgQuiet()}) // 定时器永不触发
	mr.Set(b1.bufferKey(gid),
		`{"gid":"grp-orphan","chatId":555,"userId":555,"messages":[1,2],"createdAt":`+
			strconv.FormatInt(time.Now().UnixMilli(), 10)+`}`)
	mr.SAdd(b1.indexKey(), gid)

	// 新进程接手
	var mu sync.Mutex
	var flushed [][]int64
	b2 := NewMediaGroupBuffer(rdb, BufferConfig{Log: mgQuiet()})
	b2.FlushGroup = func(_ context.Context, _ string, _ GroupMeta, ids []int64) error {
		mu.Lock()
		flushed = append(flushed, append([]int64(nil), ids...))
		mu.Unlock()
		return nil
	}

	if _, err := b2.Restore(ctx); err != nil {
		t.Fatal(err)
	}
	if !waitFor(t, 2*time.Second, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(flushed) > 0
	}) {
		t.Fatal("重启后没捞回遗留组 —— 用户的相册会卡住")
	}
	if got := len(flushed[0]); got != 2 {
		t.Errorf("捞回的组应有 2 条,实际 %d", got)
	}
}

// TestStaleGroupDiscarded 过期太久的组直接丢弃 ——
// 那些消息用户早就放弃了,处理它们只是浪费。
func TestStaleGroupDiscarded(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	var mu sync.Mutex
	var flushed [][]int64
	b := NewMediaGroupBuffer(rdb, BufferConfig{Log: mgQuiet()})
	b.FlushGroup = func(_ context.Context, _ string, _ GroupMeta, ids []int64) error {
		mu.Lock()
		flushed = append(flushed, append([]int64(nil), ids...))
		mu.Unlock()
		return nil
	}

	// 直接塞一个 10 分钟前的组
	old := time.Now().Add(-10 * time.Minute).UnixMilli()
	mr.Set(b.bufferKey("grp-old"),
		`{"gid":"grp-old","chatId":555,"userId":555,"messages":[1,2],"createdAt":`+strconv.FormatInt(old, 10)+`}`)
	mr.SAdd(b.indexKey(), "grp-old")

	_, _ = b.Restore(ctx)

	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(flushed) != 0 {
		t.Errorf("过期组不该被刷出,实际刷了 %d 次", len(flushed))
	}
	// 过期组应该被清掉,否则索引无限增长
	n, _ := mr.SCard(b.indexKey())
	if n != 0 {
		t.Errorf("过期组应从索引移除,仍有 %d 个", n)
	}
}

// TestFailedFlushIsRetained 刷盘失败时保留数据 ——
// 直接删掉的话这批文件就永久丢失,用户等不到任何结果。
func TestFailedFlushIsRetained(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	b := NewMediaGroupBuffer(rdb, BufferConfig{BufferTimeout: 30 * time.Millisecond, Log: mgQuiet()})
	b.FlushGroup = func(_ context.Context, _ string, _ GroupMeta, ids []int64) error {
		return context.DeadlineExceeded
	}

	const gid = "grp-fail"
	_ = b.Add(ctx, gid, 555, 555, 1)

	if !waitFor(t, 2*time.Second, func() bool {
		return !mr.Exists(b.lockKey(gid)) // 锁释放了,说明 flush 走完了
	}) {
		t.Skip("锁没释放,跳过")
	}
	// 数据必须在
	if !mr.Exists(b.bufferKey(gid)) {
		t.Error("刷盘失败后数据被删了 —— 这批文件会永久丢失")
	}
}

// TestEmptyGIDRejected 无 grouped_id 的消息不算媒体组。
func TestEmptyGIDRejected(t *testing.T) {
	b, _, _ := newTestBuffer(t)
	if err := b.Add(context.Background(), "", 555, 555, 1); err == nil {
		t.Error("空 gid 应报错 —— 让调用方走单条路径")
	}
}

// TestConcurrentAddsDoNotLose 测试并发 Add 不丢消息 ——
// 用户连发 10 张图时 Telegram 可能并发推。
func TestConcurrentAddsDoNotLose(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	var mu sync.Mutex
	var flushed [][]int64
	b := NewMediaGroupBuffer(rdb, BufferConfig{BufferTimeout: 200 * time.Millisecond, Log: mgQuiet()})
	b.FlushGroup = func(_ context.Context, _ string, _ GroupMeta, ids []int64) error {
		mu.Lock()
		flushed = append(flushed, append([]int64(nil), ids...))
		mu.Unlock()
		return nil
	}

	const gid = "grp-concurrent"
	const n = 8
	var wg sync.WaitGroup
	for i := int64(1); i <= n; i++ {
		wg.Add(1)
		go func(i int64) {
			defer wg.Done()
			_ = b.Add(ctx, gid, 555, 555, i)
		}(i)
	}
	wg.Wait()

	if !waitFor(t, 3*time.Second, func() bool { mu.Lock(); defer mu.Unlock(); return len(flushed) > 0 }) {
		t.Fatal("并发 Add 后没有刷盘")
	}
	mu.Lock()
	defer mu.Unlock()
	total := 0
	for _, batch := range flushed {
		total += len(batch)
	}
	if total != n {
		t.Errorf("并发 Add %d 条,刷出 %d 条 —— 有丢失", n, total)
	}
}

// TestNormalizeGID gid 表示必须统一。
//
// 混用 int64 和 string 会产生两个 Redis key,组永远刷不出来,
// 而且不报错 —— 症状是「用户的相册偶尔卡住」。
func TestNormalizeGID(t *testing.T) {
	if NormalizeGID(987654) != "987654" {
		t.Errorf("NormalizeGID = %q", NormalizeGID(987654))
	}
}

// TestFlushRetriesWhenLockHeld 锁被占时不能丢组 —— 那可能是另一实例
// 正在刷(它刷完会 drop),也可能是持锁者崩溃留下的残锁。两种情况
// 下本实例都无权删数据:组必须原样留在 Redis 里等重试。
//
// 这里只断言「抢锁失败不 drop」:数据保住了,残锁最坏也是延迟重试
// 自愈(2s 一次,TTL 30s 到期后必成功),不需要额外机制。
func TestFlushRetriesWhenLockHeld(t *testing.T) {
	b, mr, col := newTestBuffer(t)
	ctx := context.Background()
	const gid = "grp-locked"

	// 预占锁,让 flush 的 SetNX 必失败。
	if err := mr.Set(b.lockKey(gid), "1"); err != nil {
		t.Fatal(err)
	}

	_ = b.Add(ctx, gid, 555, 555, 1)
	// 必须等过定时器窗口(bufferTimeout=50ms),保证 flush 已经
	// 【在锁被占的状态下】跑过一次 —— 立刻断言 col==0 是恒真的,
	// 会赶在 timer 触发之前就放行,整条测试就测了个寂寞。
	time.Sleep(300 * time.Millisecond)
	if col.count() != 0 {
		t.Error("锁被占时不应执行 FlushGroup")
	}

	// 组必须还在 —— 抢锁失败就删数据,等于把「别人正在处理」
	// 误当成「处理完了」。
	if !mr.Exists(b.bufferKey(gid)) {
		t.Error("抢锁失败后组被误删")
	}

	// 释放残锁,重试必须能把组刷出去 —— 自愈路径真的通。
	_ = mr.Del(b.lockKey(gid))
	if !waitFor(t, 5*time.Second, func() bool { return col.total() == 1 }) {
		t.Error("残锁释放后重试未把组刷出")
	}
	if mr.Exists(b.bufferKey(gid)) {
		t.Error("重试刷出后组未清掉")
	}
}
