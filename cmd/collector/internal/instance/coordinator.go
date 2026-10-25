// Package instance 让 Go 实例能像 Node 一样参与多实例协调。
//
// 为什么在「单实例」精简之后还需要它:切换期正好是多实例 ——
// Node 和 Go 同时活着,必须靠锁决定谁处理消息、webhook 打到谁。
// 锁语义必须与 JS 侧 InstanceCoordinator 逐字一致,否则两边互相
// 认不出对方的锁值,结果是互踢或双实例同时处理。
package instance

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math/rand"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
)

// 键名与 src/domain/cache-keys.js 保持一致。
const (
	lockPrefix      = "lock:"
	instancePrefix  = "instance:"
	TelegramLockKey = "telegram_client"

	// TelegramLockTTL 与 JS 侧 TELEGRAM_CLIENT_LOCK_TTL_SECONDS 一致(90s)。
	// 续租间隔取 TTL 的 1/3 —— 与 Node 的心跳节奏相当。
	TelegramLockTTL = 90 * time.Second
	lockRenewEvery  = 30 * time.Second

	// instanceTimeout 与 JS 侧 InstanceRepository.findAllActive 一致(45s)。
	// 超过这个时间没心跳的实例不算活跃,它的锁可以被抢占。
	instanceTimeout = 45 * time.Second

	// heartbeatEvery 是实例心跳间隔。TTL(instanceTimeout*2=90s)的 1/6,
	// 留足重试余量:单次心跳失败不该让实例键过期。
	heartbeatEvery = 15 * time.Second
)

// LockValue 是锁在 Redis 里的 JSON 结构。
//
// 字段名和语义必须与 JS 侧 _createLockValue 完全一致 —— JS 用
// leaseId 做 CAS 的比较基准,名字或结构不同,续租就会永远不命中。
type LockValue struct {
	InstanceID string `json:"instanceId"`
	AcquiredAt int64  `json:"acquiredAt"`
	TTL        int64  `json:"ttl"` // 秒
	LeaseID    string `json:"leaseId"`
}

// InstanceInfo 是注册到 Redis 的实例信息。
//
// url 决定 LB 把 webhook 转发到哪 —— 这就是「Go 接管」的机制:
// Go 抢到锁并注册,LB 就会把流量打到 Go。无需改 LB 配置。
// activeTaskCount 对齐 JS 侧 InstanceCoordinator，供 LB 动态均衡和监控探针读取。
type InstanceInfo struct {
	ID              string `json:"id"`
	URL             string `json:"url"`
	Hostname        string `json:"hostname"`
	Region          string `json:"region"`
	StartedAt       int64  `json:"startedAt"`
	LastHeartbeat   int64  `json:"lastHeartbeat"`
	Status          string `json:"status"`
	ActiveTaskCount int    `json:"activeTaskCount"`
}

// Coordinator 管理本实例的注册与锁。
type Coordinator struct {
	redis  *redis.Client
	id     string
	url    string
	log    *slog.Logger
	now    func() time.Time
	region string

	// heartbeatEvery 是实例心跳间隔。默认 15s,测试里缩短以验证
	// 「心跳真的在持续刷新」—— 这个行为出问题时是静默的(实例键
	// 过期消失,但锁还在续),只有真跑过几次心跳才测得出来。
	heartbeatEvery time.Duration

	// activeTaskCounter 活跃任务计数回调
	activeTaskCounter func() int
}

// NewCoordinator 构造协调器。
//
// id / url 决定 LB 路由,必须与 Node 侧同样的推导方式
// (JS: _getPreferredPublicUrl)。
func NewCoordinator(rdb *redis.Client, id, publicURL string, log *slog.Logger) *Coordinator {
	if log == nil {
		log = slog.Default()
	}
	if id == "" {
		id = os.Getenv("INSTANCE_ID")
	}
	if id == "" {
		id = fmt.Sprintf("go-%d", time.Now().Unix())
	}
	region := os.Getenv("INSTANCE_REGION")
	if region == "" {
		region = "unknown"
	}
	return &Coordinator{
		redis:          rdb,
		id:             id,
		url:            publicURL,
		log:            log,
		now:            time.Now,
		region:         region,
		heartbeatEvery: heartbeatEvery,
	}
}

// ID 返回实例 ID。
func (c *Coordinator) ID() string { return c.id }

// RegisterActiveTaskCounter 注册活跃任务计数回调函数，用于心跳上报负载指标。
func (c *Coordinator) RegisterActiveTaskCounter(fn func() int) {
	c.activeTaskCounter = fn
}

// Register 把本实例写进 Redis,并周期性刷新心跳。
//
// 心跳是「本实例还活着」的信号:Node 判断能否抢占别人锁时,靠的就是
// instance:<id> 存在且 lastHeartbeat 新鲜。
func (c *Coordinator) Register(ctx context.Context) error {
	if c.redis == nil {
		return fmt.Errorf("instance: 未配置 Redis")
	}
	if err := c.registerOnce(ctx); err != nil {
		return err
	}

	every := c.heartbeatEvery
	if every <= 0 {
		every = heartbeatEvery
	}
	go func() {
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				c.deregister()
				return
			case <-ticker.C:
				if err := c.registerOnce(ctx); err != nil {
					c.log.Warn("实例心跳失败", "err", err)
				}
			}
		}
	}()
	return nil
}

func (c *Coordinator) registerOnce(ctx context.Context) error {
	now := c.now()
	activeCount := 0
	if c.activeTaskCounter != nil {
		activeCount = c.activeTaskCounter()
	}
	payload, err := json.Marshal(InstanceInfo{
		ID:              c.id,
		URL:             c.url,
		Hostname:        os.Getenv("HOSTNAME"),
		Region:          c.region,
		StartedAt:       now.UnixMilli(),
		LastHeartbeat:   now.UnixMilli(),
		Status:          "active",
		ActiveTaskCount: activeCount,
	})
	if err != nil {
		return err
	}
	// TTL 略大于 instanceTimeout:心跳断了 key 才会消失,
	// 那个时刻才算「这个实例真的下线了」。
	ttl := instanceTimeout * 2
	return c.redis.Set(ctx, instancePrefix+c.id, payload, ttl).Err()
}

func (c *Coordinator) deregister() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.redis.Del(ctx, instancePrefix+c.id).Err(); err != nil {
		c.log.Warn("注销实例失败(锁会被他人抢占)", "err", err)
	}
}

// lockKey 返回锁的完整 Redis key。
func (c *Coordinator) lockKey(name string) string { return lockPrefix + name }

// readLock 读锁值。
//
// corrupted=true 表示 key 存在但解析不了 —— 调用方必须先删掉它再重建,
// 否则 SET NX 永远失败(那个坏 key 还在),系统会静默地永久停止处理消息。
func (c *Coordinator) readLock(ctx context.Context, name string) (v *LockValue, missing, corrupted bool, err error) {
	raw, err := c.redis.Get(ctx, c.lockKey(name)).Bytes()
	if err == redis.Nil {
		return nil, true, false, nil
	}
	if err != nil {
		return nil, false, false, err
	}
	var lv LockValue
	if err := json.Unmarshal(raw, &lv); err != nil {
		return nil, false, true, nil
	}
	return &lv, false, false, nil
}

// deleteCorruptedLock 删掉解析不了的锁。
func (c *Coordinator) deleteCorruptedLock(ctx context.Context, name string) error {
	return c.redis.Del(ctx, c.lockKey(name)).Err()
}

// setLockIfNotExists 原子抢占:SET NX。
func (c *Coordinator) setLockIfNotExists(ctx context.Context, name string, lv *LockValue, ttl time.Duration) (bool, error) {
	payload, err := json.Marshal(lv)
	if err != nil {
		return false, err
	}
	if ttl <= 0 {
		ttl = TelegramLockTTL
	}
	ok, err := c.redis.SetNX(ctx, c.lockKey(name), payload, ttl).Result()
	return ok, err
}

// setLockIfEquals CAS 续租:只有锁值还是 ours 时才覆盖。
func (c *Coordinator) setLockIfEquals(ctx context.Context, name string, next, current *LockValue, ttl time.Duration) (bool, error) {
	if current == nil {
		return c.setLockIfNotExists(ctx, name, next, ttl)
	}
	curPayload, err := json.Marshal(current)
	if err != nil {
		return false, err
	}
	nextPayload, err := json.Marshal(next)
	if err != nil {
		return false, err
	}
	if ttl <= 0 {
		ttl = TelegramLockTTL
	}
	// Lua 保证「比较 + 写入」原子。分开做的话,两个续租会同时通过比较。
	const lua = `
local cur = redis.call('GET', KEYS[1])
if cur == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
  return 1
end
return 0
`
	res, err := c.redis.Eval(ctx, lua, []string{c.lockKey(name)},
		string(curPayload), string(nextPayload), int(ttl.Seconds())).Int()
	if err != nil {
		return false, err
	}
	return res == 1, nil
}

// newLockValue 复刻 JS 侧 _createLockValue。
//
// leaseId 复用上一份锁的值 —— 这是 Node 的行为,改了会导致 Node 的
// 续租 CAS 永远不命中,两边互相认为对方持锁。
func (c *Coordinator) newLockValue(prev *LockValue, ttl time.Duration) *LockValue {
	leaseID := ""
	if prev != nil && prev.InstanceID == c.id && prev.LeaseID != "" {
		leaseID = prev.LeaseID
	}
	if leaseID == "" {
		leaseID = fmt.Sprintf("%s:%d:%s", c.id, c.now().UnixMilli(), randomID())
	}
	if ttl <= 0 {
		ttl = TelegramLockTTL
	}
	return &LockValue{
		InstanceID: c.id,
		AcquiredAt: c.now().UnixMilli(),
		TTL:        int64(ttl.Seconds()),
		LeaseID:    leaseID,
	}
}

// ownerAlive 检查锁持有者是否还活跃(Node 的抢占依据)。
func (c *Coordinator) ownerAlive(ctx context.Context, instanceID string) bool {
	raw, err := c.redis.Get(ctx, instancePrefix+instanceID).Bytes()
	if err != nil {
		return false
	}
	var info InstanceInfo
	if err := json.Unmarshal(raw, &info); err != nil {
		return false
	}
	age := c.now().UnixMilli() - info.LastHeartbeat
	return age < instanceTimeout.Milliseconds()
}

// ActiveInstances 列出当前活跃的实例 —— /diagnosis 的「多实例状态」段。
func (c *Coordinator) ActiveInstances(ctx context.Context) ([]InstanceInfo, error) {
	if c.redis == nil {
		return nil, fmt.Errorf("instance: 未配置 Redis")
	}
	var cursor uint64
	var out []InstanceInfo
	for {
		keys, next, err := c.redis.Scan(ctx, cursor, instancePrefix+"*", 100).Result()
		if err != nil {
			return nil, fmt.Errorf("instance: 扫描活跃实例失败: %w", err)
		}
		for _, key := range keys {
			raw, err := c.redis.Get(ctx, key).Bytes()
			if err != nil {
				continue // 扫描与读取之间实例可能刚好下线
			}
			var info InstanceInfo
			if err := json.Unmarshal(raw, &info); err != nil {
				continue
			}
			if c.now().UnixMilli()-info.LastHeartbeat < instanceTimeout.Milliseconds() {
				out = append(out, info)
			}
		}
		if next == 0 {
			return out, nil
		}
		cursor = next
	}
}

// IsClusterLeader 按照字典序最小原则选举集群管理 Leader（对齐 JS 端 watchInstances 实现）。
func (c *Coordinator) IsClusterLeader(ctx context.Context) (bool, error) {
	actives, err := c.ActiveInstances(ctx)
	if err != nil {
		return false, err
	}
	if len(actives) == 0 {
		return true, nil
	}
	leaderID := actives[0].ID
	for _, inst := range actives {
		if inst.ID < leaderID {
			leaderID = inst.ID
		}
	}
	return leaderID == c.id, nil
}

// CleanupExpiredInstances 清理已失效或过期的实例心跳键，防止 Redis 中残留僵尸实例（对齐 JS 端 cleanupExpiredInstances）。
func (c *Coordinator) CleanupExpiredInstances(ctx context.Context, maxAge time.Duration) (int, error) {
	if c.redis == nil {
		return 0, fmt.Errorf("instance: 未配置 Redis")
	}
	if maxAge <= 0 {
		maxAge = instanceTimeout * 2
	}
	var cursor uint64
	cleaned := 0
	for {
		keys, next, err := c.redis.Scan(ctx, cursor, instancePrefix+"*", 100).Result()
		if err != nil {
			return cleaned, err
		}
		for _, key := range keys {
			raw, err := c.redis.Get(ctx, key).Bytes()
			if err != nil {
				continue
			}
			var info InstanceInfo
			if err := json.Unmarshal(raw, &info); err != nil {
				_ = c.redis.Del(ctx, key).Err()
				cleaned++
				continue
			}
			age := time.Duration(c.now().UnixMilli()-info.LastHeartbeat) * time.Millisecond
			if age > maxAge {
				_ = c.redis.Del(ctx, key).Err()
				cleaned++
			}
		}
		if next == 0 {
			break
		}
		cursor = next
	}
	return cleaned, nil
}

// AcquireTelegramLock 尝试拿到 telegram_client 锁。
//
// 语义与 JS 侧 _tryAcquire 一致:
//   - 锁不存在 → SET NX
//   - 锁被别人持有且持有者活跃 → 失败
//   - 锁被别人持有但持有者已下线 → CAS 抢占
//   - 锁是自己持有 → CAS 续租
func (c *Coordinator) AcquireTelegramLock(ctx context.Context) (bool, error) {
	if c.redis == nil {
		return false, fmt.Errorf("instance: 未配置 Redis")
	}
	current, missing, corrupted, err := c.readLock(ctx, TelegramLockKey)
	if err != nil {
		return false, err
	}
	if corrupted {
		c.log.Error("telegram_client 锁值损坏,删除后重建", "key", c.lockKey(TelegramLockKey))
		if err := c.deleteCorruptedLock(ctx, TelegramLockKey); err != nil {
			return false, err
		}
		missing = true
	}

	if missing {
		return c.setLockIfNotExists(ctx, TelegramLockKey, c.newLockValue(nil, TelegramLockTTL), TelegramLockTTL)
	}

	// 别人持有且仍然有效
	age := time.Duration(c.now().UnixMilli() - current.AcquiredAt)
	if current.InstanceID != c.id && age < time.Duration(current.TTL)*time.Second {
		if c.ownerAlive(ctx, current.InstanceID) {
			return false, nil
		}
		c.log.Info("发现残留锁(持有者已下线),尝试抢占",
			"holder", current.InstanceID)
	}

	return c.setLockIfEquals(ctx, TelegramLockKey, c.newLockValue(current, TelegramLockTTL), current, TelegramLockTTL)
}

// GetTelegramLockHolder 获取当前 telegram_client 锁的持有者 instanceId。
func (c *Coordinator) GetTelegramLockHolder(ctx context.Context) (string, error) {
	current, missing, _, err := c.readLock(ctx, TelegramLockKey)
	if err != nil {
		return "", err
	}
	if missing || current == nil {
		return "", nil
	}
	return current.InstanceID, nil
}

// HasTelegramLock 报告本实例是否持锁。
func (c *Coordinator) HasTelegramLock(ctx context.Context) (bool, error) {
	current, missing, _, err := c.readLock(ctx, TelegramLockKey)
	if err != nil || missing {
		return false, err
	}
	return current.InstanceID == c.id, nil
}

// RenewTelegramLock 续租。返回是否仍然持有。
func (c *Coordinator) RenewTelegramLock(ctx context.Context) (bool, error) {
	has, err := c.HasTelegramLock(ctx)
	if err != nil || !has {
		return false, err
	}
	current, _, _, err := c.readLock(ctx, TelegramLockKey)
	if err != nil {
		return false, err
	}
	return c.setLockIfEquals(ctx, TelegramLockKey, c.newLockValue(current, TelegramLockTTL), current, TelegramLockTTL)
}

// ReleaseTelegramLock 主动释放 telegram_client 锁（CAS 原子释放）。
// 仅当锁持有者是当前实例时才执行删除，避免误删他人锁。
func (c *Coordinator) ReleaseTelegramLock(ctx context.Context) error {
	if c.redis == nil {
		return nil
	}
	const lua = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 1
end
local data = cjson.decode(raw)
if data and data.instanceId == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`
	return c.redis.Eval(ctx, lua, []string{c.lockKey(TelegramLockKey)}, c.id).Err()
}

// RunLockHeartbeat 周期续租直到失去锁或 ctx 结束。
func (c *Coordinator) RunLockHeartbeat(ctx context.Context) error {
	ticker := time.NewTicker(lockRenewEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			held, err := c.RenewTelegramLock(ctx)
			if err != nil {
				c.log.Warn("锁续租失败", "err", err)
				continue
			}
			if !held {
				holder, _ := c.GetTelegramLockHolder(ctx)
				if holder == "" {
					holder = "未知实例"
				}
				return fmt.Errorf("instance: 已失去 telegram_client 锁(被 %s 接管)", holder)
			}
			c.log.Debug("锁续租成功", "instance", c.id)
		}
	}
}

// ============================================================================
// 通用分布式锁（对齐 JS 端 DistributedLock 与 InstanceCoordinator.acquireLock）
// ============================================================================

// AcquireLock 获取通用分布式锁。
// 返回生成的 leaseID，若已被其他活跃实例持有则返回 acquired=false。
func (c *Coordinator) AcquireLock(ctx context.Context, key string, ttl time.Duration) (string, bool, error) {
	if c.redis == nil {
		return "", false, fmt.Errorf("instance: 未配置 Redis")
	}
	if ttl <= 0 {
		ttl = TelegramLockTTL
	}
	current, missing, corrupted, err := c.readLock(ctx, key)
	if err != nil {
		return "", false, err
	}
	if corrupted {
		_ = c.deleteCorruptedLock(ctx, key)
		missing = true
	}

	leaseID := fmt.Sprintf("%s:%d:%s", c.id, c.now().UnixMilli(), randomID())
	lv := &LockValue{
		InstanceID: c.id,
		AcquiredAt: c.now().UnixMilli(),
		TTL:        int64(ttl.Seconds()),
		LeaseID:    leaseID,
	}

	if missing {
		ok, err := c.setLockIfNotExists(ctx, key, lv, ttl)
		if err != nil || !ok {
			return "", false, err
		}
		return leaseID, true, nil
	}

	// 检查现有锁
	age := time.Duration(c.now().UnixMilli() - current.AcquiredAt)
	if current.InstanceID != c.id && age < time.Duration(current.TTL)*time.Second {
		if c.ownerAlive(ctx, current.InstanceID) {
			return "", false, nil
		}
		c.log.Info("通用锁持有者已下线，尝试抢占", "key", key, "holder", current.InstanceID)
	}

	ok, err := c.setLockIfEquals(ctx, key, lv, current, ttl)
	if err != nil || !ok {
		return "", false, err
	}
	return leaseID, true, nil
}

// RenewLock 续期分布式锁。
func (c *Coordinator) RenewLock(ctx context.Context, key string, leaseID string, ttl time.Duration) (bool, error) {
	if c.redis == nil {
		return false, fmt.Errorf("instance: 未配置 Redis")
	}
	if ttl <= 0 {
		ttl = TelegramLockTTL
	}
	current, missing, _, err := c.readLock(ctx, key)
	if err != nil || missing || current == nil {
		return false, err
	}
	if current.InstanceID != c.id || (leaseID != "" && current.LeaseID != leaseID) {
		return false, nil
	}
	next := &LockValue{
		InstanceID: c.id,
		AcquiredAt: c.now().UnixMilli(),
		TTL:        int64(ttl.Seconds()),
		LeaseID:    current.LeaseID,
	}
	return c.setLockIfEquals(ctx, key, next, current, ttl)
}

// ReleaseLock 释放通用分布式锁（CAS 原子释放）。
func (c *Coordinator) ReleaseLock(ctx context.Context, key string, leaseID string) error {
	if c.redis == nil {
		return nil
	}
	const lua = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 1 end
local data = cjson.decode(raw)
if data and data.instanceId == ARGV[1] then
  if not ARGV[2] or ARGV[2] == '' or data.leaseId == ARGV[2] then
    redis.call('DEL', KEYS[1])
    return 1
  end
end
return 0
`
	return c.redis.Eval(ctx, lua, []string{c.lockKey(key)}, c.id, leaseID).Err()
}

// AcquireTaskLock 获取任务分布式锁，防止多实例并发处理同一任务（对齐 JS 端 acquireTaskLock）。
func (c *Coordinator) AcquireTaskLock(ctx context.Context, taskID string, ttl time.Duration) (string, bool, error) {
	return c.AcquireLock(ctx, "task:"+taskID, ttl)
}

// ReleaseTaskLock 释放任务分布式锁（对齐 JS 端 releaseTaskLock）。
func (c *Coordinator) ReleaseTaskLock(ctx context.Context, taskID string, leaseID string) error {
	return c.ReleaseLock(ctx, "task:"+taskID, leaseID)
}

func randomID() string {
	const hex = "0123456789abcdef"
	b := make([]byte, 32)
	for i := range b {
		b[i] = hex[rand.Intn(16)]
	}
	return string(b)
}
