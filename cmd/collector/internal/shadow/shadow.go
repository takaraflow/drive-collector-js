// Package shadow 实现影子模式:Go 侧连接 Telegram,但绝不处理消息。
//
// 为什么需要它
//
// 迁移 Telegram 客户端最大的风险不是「跑不起来」,而是「跑起来了
// 但行为和 Node 不一样」——比如少了某个 update 类型、少了一条消息、
// 事件顺序不同。这类差异在线上要几天才暴露一次,代价太高。
//
// 影子模式把风险反过来:Go 和 Node 同时连着,Go 看到什么就记下来,
// 但一条都不处理。跑一段时间比对两边看到的 update 流,一致了才敢切。
//
// 三条铁律(改动前先读)
//
//  1. 不碰 telegram_client 锁 —— 那是 Node 的心跳来源。抢了会把
//     线上实例踢下线,触发 AUTH_KEY_DUPLICATED(记忆里的 PR#445/447)。
//  2. 不调任何有副作用的 API —— 不 sendMessage、不 markRead、
//     不 deleteMessages、不确认消息。看到的 update 一律丢弃。
//  3. 不写回 session —— session 是 Node 的。Go 侧改了会让 Node 下次
//     加载到不一致的 authKey。
//
// 只读,并且只读锁之外的东西。
package shadow

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/shadowfingerprint"
)

// SettingsKey 与 JS 侧 SettingsRepository.getSettingsKey 对应。
const SettingsKey = "setting:tg_bot_session"

// 窗口参数必须与 Node 侧 ShadowRecorder 完全一致,否则 diff 拿
// 「最近 15 分钟的滚动窗」去比「进程启动至今的累计」,Match 恒为
// false,判据直接失效。
//
// 判定口径:只统计【已走完的整分钟】,当前这一分钟不计入。
// 理由是 Node 侧每 60s 才 flush 一次,正在积累的这一分钟它也看不到 ——
// 双方都排除掉才对得齐。
const (
	// WindowSeconds 是 Node 侧 cache.set 的 TTL(15 分钟)。
	WindowSeconds = 15 * 60
	// bucketSeconds 与 Node 侧 flush 间隔一致,保证桶边界对齐。
	bucketSeconds = 60
	// windowBuckets 是窗口内保留的桶数。
	windowBuckets = WindowSeconds / bucketSeconds
)

// Observation 是一次观察到的 update 的最小摘要。
//
// 刻意只记「可比较的指纹」而非完整消息体:
//   - 完整消息体含用户内容,落盘等于建了个隐私黑洞
//   - 迁移要比的是「看到什么」,不是「内容是什么」
type Observation struct {
	At      time.Time `json:"at"`
	Kind    string    `json:"kind"`
	Points  int       `json:"points"`
	Date    int       `json:"date,omitempty"`
	Session int       `json:"sessionId"`

	// Feature 是跨语言共享的指纹输入。用共享契约而不是本地字段 ——
	// 两份指纹实现必然漂移,而漂移的表现是「diff 全是噪声」。
	Feature shadowfingerprint.Observation `json:"feature"`

	// Fingerprint 由共享契约算出。
	Fingerprint string `json:"fingerprint"`
}

// bucket 是一分钟内的计数。
type bucket struct {
	start  time.Time
	byFP   map[string]int
	byType map[string]int
	total  int
}

// Observer 汇总观察结果,按分钟分桶实现滚动窗口。
//
// 锁是必需的:gotd 从多个 goroutine 调 UpdateHandler,不加锁时
// map 写入会 data race(实测 race detector 报 shadow.go 的 map 写)。
// 注意:测试「碰巧」串行调用时 race detector 不会报 —— 必须有真正
// 并发的测试才守得住,见 race_test.go。
type Observer struct {
	Log *slog.Logger

	mu      sync.Mutex
	buckets []*bucket // 按 start 升序,长度不超过 windowBuckets
	total   int       // 进程启动至今的累计,只用于「是否启动过」的判断
	first   time.Time
	last    time.Time
}

func NewObserver(log *slog.Logger) *Observer {
	return &Observer{Log: log}
}

// Record 记录一次观察。只打印摘要,不打消息内容。
func (o *Observer) Record(obs Observation) {
	fp := shadowfingerprint.Compute(obs.Feature)
	start := obs.At.Truncate(bucketSeconds * time.Second)

	o.mu.Lock()
	o.total++
	if o.first.IsZero() {
		o.first = obs.At
	}
	o.last = obs.At

	b := o.bucketForLocked(start)
	b.total++
	b.byFP[fp]++
	b.byType[obs.Feature.TypeID]++
	o.evictLocked()
	o.mu.Unlock()

	o.Log.Info("shadow update",
		"kind", obs.Kind,
		"points", obs.Points,
		"typeId", obs.Feature.TypeID,
		"fingerprint", fp,
	)
}

// bucketForLocked 找到 start 对应的桶,没有就建。调用方必须持锁。
func (o *Observer) bucketForLocked(start time.Time) *bucket {
	if n := len(o.buckets); n > 0 && o.buckets[n-1].start.Equal(start) {
		return o.buckets[n-1]
	}
	b := &bucket{start: start, byFP: map[string]int{}, byType: map[string]int{}}
	o.buckets = append(o.buckets, b)
	return b
}

// evictLocked 丢掉超出窗口的桶。调用方必须持锁。
func (o *Observer) evictLocked() {
	if len(o.buckets) <= windowBuckets {
		return
	}
	o.buckets = o.buckets[len(o.buckets)-windowBuckets:]
}

// Snapshot 返回窗口内指纹计数的副本。
//
// 只统计【已走完的整分钟】—— 当前这一分钟排除,理由见 WindowSeconds
// 的注释。这样 Go 侧看到的时间跨度与 Node 侧 Redis 里的一致。
func (o *Observer) Snapshot() map[string]int {
	o.mu.Lock()
	defer o.mu.Unlock()
	snap, _ := o.windowedLocked()
	return snap
}

// WindowedSnapshot 返回窗口内的指纹计数与总条数(与 Node 侧同口径)。
func (o *Observer) WindowedSnapshot() (map[string]int, int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.windowedLocked()
}

// windowedLocked 汇总窗口内(不含当前分钟)的计数。调用方必须持锁。
func (o *Observer) windowedLocked() (map[string]int, int) {
	cutoff := o.last.Truncate(bucketSeconds * time.Second)
	out := make(map[string]int)
	total := 0
	for _, b := range o.buckets {
		if !b.start.Before(cutoff) {
			continue
		}
		for fp, n := range b.byFP {
			out[fp] += n
		}
		total += b.total
	}
	return out, total
}

// Total 返回进程启动至今的累计条数(跨窗口,不衰减)。
func (o *Observer) Total() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.total
}

// Started 报告是否收到过任何 update —— 用来区分「Go 还没连上」
// 和「连上了但这段时间确实没消息」。这两种情况在 diff 里必须
// 区分开:前者是环境没就绪,后者是真实的空窗。
func (o *Observer) Started() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.total > 0
}

// Summary 输出可与 Node 侧比对的摘要。
type Summary struct {
	Total  int            `json:"total"`
	ByType map[string]int `json:"byType"`
	First  time.Time      `json:"first"`
	Last   time.Time      `json:"last"`
	Window string         `json:"window"`
	// WindowedTotal 是窗口内条数(与 Node 侧同口径),Total 是进程累计。
	WindowedTotal int `json:"windowedTotal"`
}

func (o *Observer) Summary() Summary {
	o.mu.Lock()
	defer o.mu.Unlock()

	cutoff := o.last.Truncate(bucketSeconds * time.Second)
	byType := map[string]int{}
	windowed := 0
	for _, b := range o.buckets {
		if !b.start.Before(cutoff) {
			continue
		}
		for k, v := range b.byType {
			byType[k] += v
		}
		windowed += b.total
	}

	w := "0s"
	if len(o.buckets) > 0 {
		w = cutoff.Sub(o.buckets[0].start).String()
	}

	return Summary{
		Total:         o.total,
		ByType:        byType,
		First:         o.first,
		Last:          o.last,
		Window:        w,
		WindowedTotal: windowed,
	}
}

// MarshalSummary 供调试端点使用。
func (o *Observer) MarshalSummary() ([]byte, error) {
	return json.MarshalIndent(o.Summary(), "", "  ")
}
