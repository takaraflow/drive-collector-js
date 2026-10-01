package shadow

import (
	"context"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func obsAt(t time.Time, fpType string, textLen int) Observation {
	return Observation{
		At:      t,
		Kind:    "UpdateNewMessage",
		Feature: featureOf(fpType, textLen),
	}
}

func featureOf(typeID string, textLen int) (f struct {
	TypeID   string
	HasMedia bool
	TextLen  int
	GroupID  string
}) {
	f.TypeID = typeID
	f.TextLen = textLen
	return
}

// TestWindowExcludesCurrentMinute 两侧口径必须一致。
//
// Node 每 60s flush 一次,正在积累的这一分钟它也看不到。Go 侧若
// 把当前分钟算进去,窗口就比 Node 多出最多 60 秒的数据,delta 恒为正。
func TestWindowExcludesCurrentMinute(t *testing.T) {
	o := NewObserver(quietLogger())

	base := time.Unix(testBaseUnix, 0).UTC()
	// 两分钟前的一个完整分钟
	o.Record(obsAt(base.Add(2*time.Minute), "1f2b0afd", 5))
	// 当前这一分钟(不含截止点)
	o.Record(obsAt(base.Add(3*time.Minute), "1f2b0afd", 5))

	snap, total := o.WindowedSnapshot()
	if total != 1 {
		t.Errorf("窗口内条数 = %d,期望 1(当前这一分钟应被排除)", total)
	}
	if len(snap) != 1 {
		t.Errorf("窗口内指纹数 = %d,期望 1", len(snap))
	}
}

// TestOldBucketsEvicted 超窗口的数据必须被丢掉。
//
// 这正是 review 指出的问题:Go 侧原本进程启动至今永不衰减,而 Node 是
// 15 分钟滚动窗。跑满一小时后 delta 单调增长,Match 恒为 false。
func TestOldBucketsEvicted(t *testing.T) {
	o := NewObserver(quietLogger())

	base := time.Unix(testBaseUnix, 0).UTC()
	// 20 分钟前 —— 早已超出 15 分钟窗口
	o.Record(obsAt(base, "1f2b0afd", 5))
	// 5 分钟前 —— 在窗口内
	o.Record(obsAt(base.Add(5*time.Minute), "1f2b0afd", 5))

	_, total := o.WindowedSnapshot()
	if total != 1 {
		t.Errorf("窗口内条数 = %d,期望 1(20 分钟前的数据应被淘汰)", total)
	}

	// 桶的数量也应受控,否则长时间运行会无限增长
	o.mu.Lock()
	buckets := len(o.buckets)
	o.mu.Unlock()
	if buckets > windowBuckets {
		t.Errorf("桶数 = %d,超过窗口上限 %d", buckets, windowBuckets)
	}
}

// TestBucketsBoundedUnderLongRun 长时间运行桶数必须有界 ——
// 无界增长是内存泄漏,影子容器跑几天就 OOM。
func TestBucketsBoundedUnderLongRun(t *testing.T) {
	o := NewObserver(quietLogger())
	base := time.Unix(testBaseUnix, 0).UTC()

	for i := 0; i < 24*60; i++ { // 模拟连续 24 小时,每分钟一条
		o.Record(obsAt(base.Add(time.Duration(i)*time.Minute), "1f2b0afd", 1))
	}

	o.mu.Lock()
	buckets := len(o.buckets)
	o.mu.Unlock()
	if buckets > windowBuckets {
		t.Errorf("24 小时后桶数 = %d,超过上限 %d", buckets, windowBuckets)
	}

	_, total := o.WindowedSnapshot()
	if total > windowBuckets {
		t.Errorf("窗口内条数 = %d,超过 %d —— 淘汰逻辑没生效", total, windowBuckets)
	}
}

// TestSameMinuteAccumulates 同一分钟内的多次观察必须累加进同一个桶。
func TestSameMinuteAccumulates(t *testing.T) {
	o := NewObserver(quietLogger())

	base := time.Unix(testBaseUnix, 0).UTC()
	for i := 0; i < 5; i++ {
		o.Record(obsAt(base.Add(time.Duration(i)*time.Second), "1f2b0afd", 1))
	}

	o.mu.Lock()
	buckets := len(o.buckets)
	o.mu.Unlock()
	if buckets != 1 {
		t.Errorf("同一分钟内产生了 %d 个桶,期望 1", buckets)
	}
}

// TestWindowedDiffGoesGreenAfterAlignment 核心场景:
// 两边在同一个 15 分钟窗口内构成一致 → Match=true。
// 这是整个影子验证「可以切流量」的正向路径。
func TestWindowedDiffGoesGreenAfterAlignment(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	o := NewObserver(quietLogger())
	base := time.Unix(testBaseUnix, 0).UTC()

	// Go 侧:base+1 分钟到 base+4 分钟,每分钟 20 条。
	// 最后一分钟(base+4)不计入窗口 —— Node 侧也看不到正在积累的那一分钟。
	const perMinute = 20
	for m := 1; m <= 4; m++ {
		for i := 0; i < perMinute; i++ {
			o.Record(obsAt(base.Add(time.Duration(m)*time.Minute), "1f2b0afd", 5))
		}
	}

	// Node 侧:窗口内三个已走完的分钟 × 20 = 60
	nodeKey := "t=1f2b0afd|media=false|text=5|gid="
	mr.Set(ShadowCountsKey, `{"`+nodeKey+`":60}`)

	d, err := o.DiffAgainstNode(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	if !d.Match {
		t.Errorf("两侧同窗口构成一致时应报 Match,实际 note=%q rows=%+v", d.Note, d.Rows)
	}
}

// TestNoShadowCountsIsNeverMatch Node 侧没记录 ≠ 一致。
//
// 这是最危险的假阳性:SHADOW_RECORD 默认关闭,Redis 里没 key,
// 而 Go 侧刚启动也空 —— 早期版本会报 Match=true。
func TestNoShadowCountsIsNeverMatch(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	o := NewObserver(quietLogger())
	base := time.Unix(testBaseUnix, 0).UTC()
	for m := 1; m <= 2; m++ {
		for i := 0; i < 20; i++ {
			o.Record(obsAt(base.Add(time.Duration(m)*time.Minute), "1f2b0afd", 5))
		}
	}
	// Redis 里【没有】 ShadowCountsKey

	d, err := o.DiffAgainstNode(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	if d.Match {
		t.Error("Node 侧无记录时绝不能报 Match=true")
	}
}

// TestGoNotStartedIsNeverMatch Go 侧没连上也不能报绿。
func TestGoNotStartedIsNeverMatch(t *testing.T) {
	mr := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	ctx := context.Background()

	// Node 侧有大量数据,Go 侧一条都没有
	nodeKey := "t=1f2b0afd|media=false|text=5|gid="
	mr.Set(ShadowCountsKey, `{"`+nodeKey+`":100}`)

	o := NewObserver(quietLogger())
	d, err := o.DiffAgainstNode(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	if d.Match {
		t.Error("Go 侧还没收到任何 update 时不能报 Match")
	}
	if o.Started() {
		t.Error("Started() 应为 false")
	}
}
