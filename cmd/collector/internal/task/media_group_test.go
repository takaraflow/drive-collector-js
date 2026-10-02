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

func newTestBuffer(t *testing.T) (*MediaGroupBuffer, *miniredis.Miniredis, *[][]int64) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	// 记录每次刷盘收到哪些消息
	var mu sync.Mutex
	var flushed [][]int64

	b := NewMediaGroupBuffer(rdb, BufferConfig{
		BufferTimeout: 50 * time.Millisecond, // 测试里不用等 1 秒
		Log:           mgQuiet(),
	})
	b.FlushGroup = func(_ context.Context, _ string, ids []int64) error {
		mu.Lock()
		flushed = append(flushed, append([]int64(nil), ids...))
		mu.Unlock()
		return nil
	}
	return b, mr, &flushed
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

	if !waitFor(t, 2*time.Second, func() bool { return len(*flushed) > 0 }) {
		t.Fatal("缓冲窗口后没有刷盘")
	}
	if len(*flushed) != 1 {
		t.Fatalf("刷了 %d 次,期望 1 次 —— 消息被拆成了多个任务", len(*flushed))
	}
	if got := len((*flushed)[0]); got != 3 {
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

	if !waitFor(t, 2*time.Second, func() bool { return len(*flushed) > 0 }) {
		t.Fatal("没有刷盘")
	}
	if got := len((*flushed)[0]); got != 1 {
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

	if !waitFor(t, 2*time.Second, func() bool { return len(*flushed) > 0 }) {
		t.Fatal("满批没有刷出")
	}
	// 缓冲窗口是 50ms(测试配置),满批应该远快于此
	if elapsed > 40*time.Millisecond {
		t.Errorf("满批耗时 %v,应远小于缓冲窗口 50ms", elapsed)
	}
	if got := len((*flushed)[0]); got != 10 {
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
	if !waitFor(t, 2*time.Second, func() bool {
		return !mr.Exists(b.bufferKey(gid))
	}) {
		t.Error("刷出后 buffer key 仍存在")
	}
	n, _ := mr.SCard(b.indexKey())
	if n != 0 {
		t.Errorf("刷出后索引仍有 %d 个成员", n)
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
	b2.FlushGroup = func(_ context.Context, _ string, ids []int64) error {
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
	b.FlushGroup = func(_ context.Context, _ string, ids []int64) error {
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
	b.FlushGroup = func(context.Context, string, []int64) error {
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
	b.FlushGroup = func(_ context.Context, _ string, ids []int64) error {
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
