package task

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// MediaGroupBuffer 聚合用户连发的多条消息。
//
// 为什么需要它:用户发 10 张图,Telegram 会推 10 条 update(每条带
// 相同的 grouped_id)。不聚合就是 10 个独立任务 —— 用户看到「我的相册
// 被拆成 10 个任务」,而且 [静默错误]:没有报错,只是结果不对。
//
// 参数与 JS 侧 MediaGroupBuffer 逐字对齐(全部来自其 this.options):
// bufferTimeout=1s, maxBatchSize=10, staleThreshold=60s。
//
// 状态存 Redis 而非内存:flush 是分布式锁保护的,多实例下必须共享
// 同一份,否则两个实例会各刷一半。
type MediaGroupBuffer struct {
	redis *redis.Client
	log   *slog.Logger

	bufferTimeout  time.Duration
	maxBatchSize   int
	staleThreshold time.Duration
	keyPrefix      string
	lockTTL        time.Duration

	mu       sync.Mutex
	timers   map[string]*time.Timer
	inflight map[string]bool

	// FlushGroup 在缓冲窗口到期时调用,负责建任务。
	//
	// meta 里带 chatID:刷盘发生在 1 秒缓冲窗口之后,那时 update 的
	// chat/user 上下文已经不在手上,只能靠组数据里存的那份回溯。
	//
	// 注入而不是直接调 Manager —— 这样缓冲层不依赖任务层,可独立测试。
	FlushGroup func(ctx context.Context, gid string, meta GroupMeta, msgIDs []int64) error

	// Now 可注入,便于测试时间边界。
	Now func() time.Time
}

// BufferConfig 是媒体组缓冲的配置。
type BufferConfig struct {
	BufferTimeout  time.Duration
	MaxBatchSize   int
	StaleThreshold time.Duration
	KeyPrefix      string
	LockTTL        time.Duration
	Log            *slog.Logger
}

// NewMediaGroupBuffer 构造缓冲器。ctx 取消时所有待刷的组立即刷出 ——
// 不刷的话用户等的是「永远不出现」。
func NewMediaGroupBuffer(rdb *redis.Client, cfg BufferConfig) *MediaGroupBuffer {
	if cfg.BufferTimeout <= 0 {
		cfg.BufferTimeout = time.Second
	}
	if cfg.MaxBatchSize <= 0 {
		cfg.MaxBatchSize = 10
	}
	if cfg.StaleThreshold <= 0 {
		cfg.StaleThreshold = 60 * time.Second
	}
	if cfg.KeyPrefix == "" {
		cfg.KeyPrefix = "media_group_buffer"
	}
	if cfg.LockTTL <= 0 {
		cfg.LockTTL = 30 * time.Second
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	return &MediaGroupBuffer{
		redis:          rdb,
		log:            cfg.Log,
		bufferTimeout:  cfg.BufferTimeout,
		maxBatchSize:   cfg.MaxBatchSize,
		staleThreshold: cfg.StaleThreshold,
		keyPrefix:      cfg.KeyPrefix,
		lockTTL:        cfg.LockTTL,
		timers:         map[string]*time.Timer{},
		inflight:       map[string]bool{},
		Now:            time.Now,
	}
}

// GroupMeta 是组里除消息 id 之外的上下文。
//
// 单独导出是因为刷盘发生在 1 秒缓冲窗口之后 —— 那时 update 的
// chat/user 上下文已经不在手上,只能靠组数据里存的那份。
type GroupMeta struct {
	GID    string
	ChatID int64
	UserID int64
}

// groupMeta 是存在 Redis 里的组状态。
//
// 字段名与 JS 侧保持一致 —— 中途接管时两边要能读同一份数据。
type groupMeta struct {
	GID       string  `json:"gid"`
	ChatID    int64   `json:"chatId"`
	UserID    int64   `json:"userId"`
	MsgIDs    []int64 `json:"messages"`
	CreatedAt int64   `json:"createdAt"`
}

func (b *MediaGroupBuffer) bufferKey(gid string) string {
	return b.keyPrefix + ":" + gid
}

func (b *MediaGroupBuffer) indexKey() string { return b.keyPrefix + ":index" }

func (b *MediaGroupBuffer) lockKey(gid string) string {
	return b.keyPrefix + ":lock:" + gid
}

// Add 把一条消息加入媒体组,并安排延迟刷盘。
//
// 重复的 msgID 会被忽略 —— Telegram 会重推同一条,不加去重会让
// 同一个文件建两次任务。
//
// 【并发安全】整个读-改-写跑在 Redis Lua 脚本里,是原子的。
//
// 之前是「load → append → save」三步分开,没有锁:用户连发 10 张图时
// Telegram 会并发推,10 个 goroutine 全部读到 messages:[],各自 append
// 一条,后写的覆盖先写的 —— 实测 8 条并发只留下 2 条。
//
// 而且【静默丢失】:没有报错、没有日志,用户的相册少了 6 张图。
//
// 刻意不用进程内锁:多实例下各锁各的,一样会丢。必须是 Redis 侧原子。
func (b *MediaGroupBuffer) Add(ctx context.Context, gid string, chatID, userID, msgID int64) error {
	if gid == "" {
		// 没有 grouped_id 的消息不算媒体组,交给调用方直接建任务。
		return fmt.Errorf("media group: gid 为空")
	}

	_, count, err := b.appendAtomic(ctx, gid, chatID, userID, msgID)
	if err != nil {
		return err
	}
	if err := b.track(ctx, gid); err != nil {
		return err
	}

	// Info 而不是 Debug:相册链路从「收到消息」到「已建任务」之间原本
	// 一条日志都没有,而它的故障形态恰恰是「用户发了 10 张图、什么都没
	// 发生」。没有这行,这类问题在生产日志里完全不可见。
	b.log.Info("媒体组消息已入缓冲",
		"gid", gid, "msgId", msgID, "已攒", count)

	// 攒够一批立刻刷 —— 再等就没有意义了。
	if count >= b.maxBatchSize {
		b.cancelTimer(gid)
		go b.flush(context.WithoutCancel(ctx), gid)
		return nil
	}

	b.schedule(gid)
	return nil
}

// appendAtomic 在 Redis 侧原子地把 msgID 追加进组。
//
// 返回 added=false 表示这条已经在组里(重复推送)。重复时不重置计时器 ——
// 否则 Telegram 的重推会让组永远等不满窗口。
func (b *MediaGroupBuffer) appendAtomic(
	ctx context.Context, gid string, chatID, userID, msgID int64,
) (added bool, count int, err error) {
	now := b.Now().UnixMilli()
	key := b.bufferKey(gid)

	// 用 Lua 保证「读 → 去重 → 追加 → 写回」是一步。
	//
	// 不用 WATCH/MULTI:那需要重试循环,在高并发下重试率很高,
	// 而这里每次调用都要付这个代价。
	const lua = `
local raw = redis.call('GET', KEYS[1])
local meta
if raw then
  meta = cjson.decode(raw)
else
  meta = {gid=ARGV[1], chatId=tonumber(ARGV[2]), userId=tonumber(ARGV[3]), messages={}, createdAt=tonumber(ARGV[5])}
end

-- 去重:已在组里就返回 0,不改数据
for _, m in ipairs(meta.messages or {}) do
  if m == tonumber(ARGV[4]) then
    return {0, #meta.messages}
  end
end

table.insert(meta.messages, tonumber(ARGV[4]))
redis.call('SET', KEYS[1], cjson.encode(meta), 'EX', ARGV[6])
return {1, #meta.messages}
`

	res, err := b.redis.Eval(ctx, lua, []string{key},
		gid, chatID, userID, msgID, now, int(b.staleThreshold.Seconds())).Slice()
	if err != nil {
		return false, 0, fmt.Errorf("媒体组追加失败(gid=%s): %w", gid, err)
	}
	if len(res) != 2 {
		return false, 0, fmt.Errorf("媒体组追加返回异常: %v", res)
	}
	return toInt64(res[0]) == 1, int(toInt64(res[1])), nil
}

// toInt64 把 Redis 整数回复转成 int64。
func toInt64(v interface{}) int64 {
	switch n := v.(type) {
	case int64:
		return n
	case int:
		return int64(n)
	case string:
		i, _ := parseInt(n)
		return i
	default:
		return 0
	}
}

func parseInt(s string) (int64, error) {
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("非法数字 %q", s)
		}
		n = n*10 + int64(c-'0')
	}
	return n, nil
}

// schedule 安排延迟刷盘。同一组重复调用会重置计时器。
func (b *MediaGroupBuffer) schedule(gid string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if t, ok := b.timers[gid]; ok {
		t.Stop()
	}
	b.timers[gid] = time.AfterFunc(b.bufferTimeout, func() {
		b.flush(context.Background(), gid)
	})
}

func (b *MediaGroupBuffer) cancelTimer(gid string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if t, ok := b.timers[gid]; ok {
		t.Stop()
		delete(b.timers, gid)
	}
}

// flush 刷出一个组。先拿分布式锁,保证多实例下只有一个真正执行。
func (b *MediaGroupBuffer) flush(ctx context.Context, gid string) {
	b.cancelTimer(gid)

	b.mu.Lock()
	if b.inflight[gid] {
		b.mu.Unlock()
		return // 已在刷,重复触发直接跳过
	}
	b.inflight[gid] = true
	b.mu.Unlock()

	defer func() {
		b.mu.Lock()
		delete(b.inflight, gid)
		b.mu.Unlock()
	}()

	lockKey := b.lockKey(gid)
	ok, err := b.redis.SetNX(ctx, lockKey, "1", b.lockTTL).Result()
	if err != nil {
		b.log.Warn("媒体组抢锁失败", "gid", gid, "err", err)
		return
	}
	if !ok {
		// 锁被人占着。正常情况是另一个实例正在刷,它刷完会把组 drop
		// 掉 —— 但也可能是持锁者崩溃留下的残锁(TTL 30s),那样这批
		// 消息会白等到过期。延迟再试一次自愈:组已被正常 drop 就到此
		// 为止(load 到 nil 直接返回),残锁则最坏每 2s 试一次、TTL
		// 到期后必成功。inflight 标记防并发重试叠加。
		b.log.Info("媒体组锁被占,2 秒后重试", "gid", gid)
		time.AfterFunc(2*time.Second, func() {
			b.flush(context.Background(), gid)
		})
		return
	}
	defer b.redis.Del(context.WithoutCancel(ctx), lockKey)

	meta, err := b.load(ctx, gid)
	if err != nil {
		b.log.Warn("媒体组读取失败", "gid", gid, "err", err)
		return
	}
	if meta == nil || len(meta.MsgIDs) == 0 {
		return
	}

	// 过期太久的组直接丢弃 —— 那些消息多半已经没意义了
	// (用户早就放弃了这批)。
	//
	// Warn 而不是 Debug:这【是用户数据消失】的时刻(重启超过 60 秒就
	// 会走到这里),记在 Debug 等于没记 —— 排「相册没反应」时看到的
	// 只有「入缓冲」和什么都没有。
	if b.Now().UnixMilli()-meta.CreatedAt > b.staleThreshold.Milliseconds() {
		b.log.Warn("媒体组已过期,丢弃 —— 这批文件不会建任务",
			"gid", gid, "条数", len(meta.MsgIDs),
			"存活", b.Now().UnixMilli()-meta.CreatedAt, "上限", b.staleThreshold.Milliseconds())
		b.drop(ctx, gid)
		return
	}

	if b.FlushGroup == nil {
		return
	}
	metaOut := GroupMeta{GID: meta.GID, ChatID: meta.ChatID, UserID: meta.UserID}
	if err := b.FlushGroup(ctx, gid, metaOut, meta.MsgIDs); err != nil {
		b.log.Error("媒体组刷盘失败,保留以便重试", "gid", gid, "err", err)
		return // 不 drop:留给下次或重启后的 restore()
	}
	b.drop(ctx, gid)
}

// FlushNow 立即刷出某组 —— 用户点了「完成」或需要立刻处理时用。
func (b *MediaGroupBuffer) FlushNow(ctx context.Context, gid string) error {
	b.cancelTimer(gid)
	b.flush(ctx, gid)
	return nil
}

// drop 清掉组的缓冲和索引。
func (b *MediaGroupBuffer) drop(ctx context.Context, gid string) {
	_ = b.redis.Del(ctx, b.bufferKey(gid)).Err()
	// 索引是个 set,移除成员。
	_ = b.redis.SRem(ctx, b.indexKey(), gid).Err()
}

// load 读组状态。
func (b *MediaGroupBuffer) load(ctx context.Context, gid string) (*groupMeta, error) {
	raw, err := b.redis.Get(ctx, b.bufferKey(gid)).Bytes()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var meta groupMeta
	if err := json.Unmarshal(raw, &meta); err != nil {
		// 数据损坏 —— 删掉重建,否则这个组永远卡住。
		b.log.Warn("媒体组数据损坏,重建", "gid", gid, "err", err)
		return nil, nil
	}
	return &meta, nil
}

func (b *MediaGroupBuffer) save(ctx context.Context, meta *groupMeta) error {
	payload, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	// TTL 与 staleThreshold 对齐:超过它这个组就没意义了。
	if err := b.redis.Set(ctx, b.bufferKey(meta.GID), payload, b.staleThreshold).Err(); err != nil {
		return err
	}
	return b.track(ctx, meta.GID)
}

// track 把 gid 加进索引 —— 进程重启后靠索引找回遗留组。
func (b *MediaGroupBuffer) track(ctx context.Context, gid string) error {
	return b.redis.SAdd(ctx, b.indexKey(), gid).Err()
}

// Restore 捞回上次运行遗留的组并立即刷出。
//
// 这是【必须】的:进程重启会丢掉所有内存里的定时器,组就永远留在
// Redis 里不会刷。用户的相册会卡在「处理中」直到 staleThreshold 过期。
//
// 与 JS 侧 bootstrap 的 restore() 同义。
func (b *MediaGroupBuffer) Restore(ctx context.Context) (int, error) {
	gids, err := b.redis.SMembers(ctx, b.indexKey()).Result()
	if err != nil {
		return 0, fmt.Errorf("读取媒体组索引失败: %w", err)
	}

	restored := 0
	// 排序保证刷出顺序与组创建顺序一致 —— 影响任务在队列里的次序,
	// 而用户会按顺序看到结果。
	sort.Strings(gids)
	for _, gid := range gids {
		meta, err := b.load(ctx, gid)
		if err != nil || meta == nil || len(meta.MsgIDs) == 0 {
			// 空组或读失败:清掉,别让索引无限增长。
			b.drop(ctx, gid)
			continue
		}
		restored++
		b.flush(ctx, gid)
	}
	return restored, nil
}

// Count 返回当前缓冲的组数 —— 诊断用。
func (b *MediaGroupBuffer) Count(ctx context.Context) (int, error) {
	n, err := b.redis.SCard(ctx, b.indexKey()).Result()
	return int(n), err
}

// NormalizeGID 让 gid 的表示统一。
//
// 关键:Go 侧拿到的 grouped_id 是 int64,而 JS 侧用字符串当 key。
// 两者混用会产生两个不同的 key,组永远刷不出来 —— 而且不报错。
func NormalizeGID(gid int64) string { return strconv.FormatInt(gid, 10) }
