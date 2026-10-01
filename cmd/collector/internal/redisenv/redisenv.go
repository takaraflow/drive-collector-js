// Package redisenv 从环境变量装配 Redis 客户端。
//
// 单独成包是因为 leader 解析和 shadow diff 都要连同一个 Redis,
// 而两边的 URL 取值顺序必须一致 —— 漂移了会出现「leader 找得到
// 但 diff 读不到」这种极难查的现象。
package redisenv

import (
	"os"
	"time"

	"github.com/redis/go-redis/v9"
)

// FromEnv 按 JS 侧 src/config/index.js 的约定构造客户端。
//
// URL 取值顺序与 JS 一致:NF_REDIS_URL 优先于 REDIS_URL ——
// Northflank 部署下前者才是对的。
//
// 返回 nil 表示没配 Redis 或 URL 非法。调用方必须自己处理 nil,
// 不要静默降级:「读不到 Redis」和「Redis 里是空的」是两件事。
func FromEnv() *redis.Client {
	raw := os.Getenv("NF_REDIS_URL")
	if raw == "" {
		raw = os.Getenv("REDIS_URL")
	}
	if raw == "" {
		return nil
	}

	opts, err := redis.ParseURL(raw)
	if err != nil {
		return nil
	}
	opts.DialTimeout = 10 * time.Second
	opts.ReadTimeout = 10 * time.Second
	opts.WriteTimeout = 10 * time.Second

	if tok := firstEnv("REDIS_TOKEN", "UPSTASH_REDIS_REST_TOKEN"); tok != "" {
		opts.Password = tok
	}
	return redis.NewClient(opts)
}

func firstEnv(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}
