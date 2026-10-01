package leader

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/redis/go-redis/v9"
)

// instancePrefix 与 JS 侧 InstanceRepository.PREFIX 一致。
const instancePrefix = "instance:"

// instanceTimeoutMs 与 InstanceRepository.DEFAULT_TIMEOUT 对齐。
// 超过这个时间没心跳的实例不算活跃,不能被当成 leader。
const instanceTimeoutMs = 45_000

// NewResolverFromEnv 按 JS 侧的环境变量约定装配 Resolver。
//
// 刻意不引 D1 客户端:活跃实例存在 Redis 里(InstanceRepository 走
// cache.listKeys + cache.get),不查 D1。少一个依赖就少一处配置漂移。
//
// Redis URL 的取值顺序与 src/config/index.js:499 一致:
// NF_REDIS_URL 优先于 REDIS_URL —— Northflank 部署下前者才是对的。
func NewResolverFromEnv() *Resolver {
	raw := os.Getenv("NF_REDIS_URL")
	if raw == "" {
		raw = os.Getenv("REDIS_URL")
	}
	if raw == "" {
		// 不配 Redis 时返回空 resolver:所有请求都会拿到 "Not Leader"
		// 而 503。比静默猜一个地址安全。
		return &Resolver{}
	}

	opts, err := redis.ParseURL(raw)
	if err != nil {
		return &Resolver{}
	}
	// 与 JS 侧保持同一套连接参数:10s 心跳、指数退避上限 30s。
	// JS 侧的 keepAlive 单位是【秒】,不是毫秒 —— 这个坑踩过一次。
	opts.DialTimeout = 10 * time.Second
	opts.ReadTimeout = 10 * time.Second
	opts.WriteTimeout = 10 * time.Second

	if tok := firstEnv("REDIS_TOKEN", "UPSTASH_REDIS_REST_TOKEN"); tok != "" {
		opts.Password = tok
	}

	client := redis.NewClient(opts)

	return &Resolver{
		LockGetter: func(ctx context.Context, key string) ([]byte, error) {
			return client.Get(ctx, key).Bytes()
		},
		ActiveLister: func(ctx context.Context) ([]Instance, error) {
			return listActiveInstances(ctx, client, instanceTimeoutMs)
		},
	}
}

func firstEnv(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}

// listActiveInstances 复刻 InstanceRepository.findAllActive:
// SCAN 出 instance:* 逐个读,再按 lastHeartbeat 过滤。
func listActiveInstances(ctx context.Context, client *redis.Client, timeoutMs int64) ([]Instance, error) {
	var keys []string
	var cursor uint64
	for {
		batch, next, err := client.Scan(ctx, cursor, instancePrefix+"*", 200).Result()
		if err != nil {
			return nil, fmt.Errorf("scan instances: %w", err)
		}
		keys = append(keys, batch...)
		cursor = next
		if cursor == 0 {
			break
		}
		// SCAN 在超大 keyspace 下可能长时间不收敛,设个上限避免
		// 边缘节点被拖住 —— 超过就拿已有的走。
		if len(keys) > 1000 {
			break
		}
	}

	now := time.Now().UnixMilli()
	out := make([]Instance, 0, len(keys))
	for _, k := range keys {
		raw, err := client.Get(ctx, k).Bytes()
		if err != nil {
			continue // 单个 key 读失败不影响其他实例
		}
		var inst struct {
			Instance
			LastHeartbeat int64 `json:"lastHeartbeat"`
		}
		if err := json.Unmarshal(raw, &inst); err != nil {
			continue
		}
		// 与 JS 一致:无心跳时间的实例不算活跃
		if inst.LastHeartbeat == 0 || now-inst.LastHeartbeat >= timeoutMs {
			continue
		}
		out = append(out, inst.Instance)
	}
	return out, nil
}