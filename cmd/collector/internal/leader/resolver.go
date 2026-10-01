// Package leader 解析 Telegram leader 实例地址。
//
// 边缘节点收到 webhook 时必须问「谁是 leader」,因为 MTProto 长连接
// 只在持锁的那个实例上跑。这里复刻 JS 侧 resolveTelegramLeaderBaseUrl
// 的链路:读 Redis 锁 → 拿 instanceId → 查活跃实例 → 取 directUrl。
package leader

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// LockKey 与 JS 侧 CACHE_KEYS.telegramClientLock() 一致。
const LockKey = "lock:telegram_client"

// Instance 对应 InstanceRepository.findAllActive 的行。
type Instance struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	DirectURL string `json:"directUrl"`
}

// Resolver 解析 leader 地址。
type Resolver struct {
	// LockGetter 返回锁的原始 JSON(如 {"instanceId":"...","version":n})。
	// 注入而非直接依赖缓存实现,便于测试,也让本包不绑定 Redis 客户端。
	LockGetter func(ctx context.Context, key string) ([]byte, error)
	// ActiveLister 返回当前活跃实例。
	ActiveLister func(ctx context.Context) ([]Instance, error)
}

// BaseURL 解析 leader 的 base URL。解析不出来时返回 ("", nil) ——
// 调用方据此决定是本地处理还是返回 503。
//
// 对应 JS 侧 resolveTelegramLeaderBaseUrl:失败一律降级为 null 而非抛错,
// 因为「找不到 leader」是正常状态(选举中/持锁实例已死),不是异常。
func (r *Resolver) BaseURL(ctx context.Context) (string, error) {
	if r.LockGetter == nil || r.ActiveLister == nil {
		return "", nil
	}

	raw, err := r.LockGetter(ctx, LockKey)
	if err != nil {
		// JS 侧对应 catch 分支:warn + 返回 null。
		return "", nil
	}
	if len(raw) == 0 {
		return "", nil
	}

	var lock struct {
		InstanceID string `json:"instanceId"`
	}
	if err := json.Unmarshal(raw, &lock); err != nil {
		return "", nil
	}
	if lock.InstanceID == "" {
		return "", nil
	}

	instances, err := r.ActiveLister(ctx)
	if err != nil {
		return "", nil
	}
	for _, inst := range instances {
		if inst.ID != lock.InstanceID {
			continue
		}
		base := normalizeBase(inst.DirectURL)
		if base == "" {
			base = normalizeBase(inst.URL)
		}
		return base, nil
	}
	return "", nil
}

// normalizeBase 对应 JS 侧 normalizePublicUrl:必须是绝对 URL,
// 去掉尾斜杠。解析失败返回 ""。
func normalizeBase(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := parseAbsolute(raw)
	if err != nil {
		return ""
	}
	return u
}

func parseAbsolute(raw string) (string, error) {
	const schemeSep = "://"
	idx := indexOf(raw, schemeSep)
	if idx <= 0 {
		return "", fmt.Errorf("not an absolute URL: %q", raw)
	}
	scheme := raw[:idx]
	if scheme != "http" && scheme != "https" {
		return "", fmt.Errorf("unsupported scheme %q", scheme)
	}
	rest := raw[idx+len(schemeSep):]
	if rest == "" {
		return "", fmt.Errorf("missing host in %q", raw)
	}
	out := raw
	for len(out) > 0 && out[len(out)-1] == '/' {
		out = out[:len(out)-1]
	}
	return out, nil
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// Timeout 与 JS 侧 forwardPostToTelegramLeader 的 15s 对齐。
const Timeout = 15 * time.Second
