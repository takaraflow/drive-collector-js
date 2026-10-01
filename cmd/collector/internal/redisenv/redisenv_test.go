package redisenv

import (
	"testing"
)

// TestNFRedisURLWinsNorthflank 部署下 NF_REDIS_URL 才是对的。
//
// 取值顺序错一次的症状是「连上了错误的 Redis」—— 不报错,
// 只是读不到任何数据,极难排查。
func TestNFRedisURLWinsNorthflank(t *testing.T) {
	t.Setenv("REDIS_URL", "redis://plain-host:6379/0")
	t.Setenv("NF_REDIS_URL", "redis://nf-host:6379/0")

	c := FromEnv()
	if c == nil {
		t.Fatal("应返回客户端")
	}
	if got := c.Options().Addr; got != "nf-host:6379" {
		t.Errorf("Addr = %q,期望 nf-host:6379(NF_REDIS_URL 应优先)", got)
	}
}

// TestFallsBackToRedisURL 没配 NF_REDIS_URL 时用 REDIS_URL。
func TestFallsBackToRedisURL(t *testing.T) {
	t.Setenv("REDIS_URL", "redis://plain-host:6379/0")
	t.Setenv("NF_REDIS_URL", "")

	c := FromEnv()
	if c == nil {
		t.Fatal("应返回客户端")
	}
	if got := c.Options().Addr; got != "plain-host:6379" {
		t.Errorf("Addr = %q,期望 plain-host:6379", got)
	}
}

// TestReturnsNilWhenUnconfigured 没配 Redis 必须返回 nil 而不是默认连 localhost。
//
// 静默连 localhost 会让「忘了配」看起来像「Redis 挂了」。
func TestReturnsNilWhenUnconfigured(t *testing.T) {
	t.Setenv("REDIS_URL", "")
	t.Setenv("NF_REDIS_URL", "")

	if c := FromEnv(); c != nil {
		t.Errorf("未配置时应返回 nil,得到 %v", c.Options().Addr)
	}
}

// TestReturnsNilOnMalformedURL URL 非法时返回 nil,不 panic。
func TestReturnsNilOnMalformedURL(t *testing.T) {
	t.Setenv("REDIS_URL", "://not-a-valid-url")
	t.Setenv("NF_REDIS_URL", "")

	if c := FromEnv(); c != nil {
		t.Error("非法 URL 应返回 nil")
	}
}

// TestTokenApplied 认证 token 要落到 Password 上。
func TestTokenApplied(t *testing.T) {
	t.Setenv("NF_REDIS_URL", "redis://h:6379/0")
	t.Setenv("REDIS_TOKEN", "secret-token")

	c := FromEnv()
	if c == nil {
		t.Fatal("应返回客户端")
	}
	if got := c.Options().Password; got != "secret-token" {
		t.Errorf("Password = %q,期望 secret-token", got)
	}
}

// TestUpstashTokenFallback Upstash 场景用另一个变量名。
func TestUpstashTokenFallback(t *testing.T) {
	t.Setenv("NF_REDIS_URL", "redis://h:6379/0")
	t.Setenv("REDIS_TOKEN", "")
	t.Setenv("UPSTASH_REDIS_REST_TOKEN", "upstash-token")

	c := FromEnv()
	if c == nil {
		t.Fatal("应返回客户端")
	}
	if got := c.Options().Password; got != "upstash-token" {
		t.Errorf("Password = %q,期望 upstash-token", got)
	}
}

// TestTimeoutsSet 超时必须有 —— 默认的 http.Client 没有超时,
// Redis 卡住会把影子容器挂死。
func TestTimeoutsSet(t *testing.T) {
	t.Setenv("NF_REDIS_URL", "redis://h:6379/0")

	c := FromEnv()
	if c == nil {
		t.Fatal("应返回客户端")
	}
	o := c.Options()
	if o.DialTimeout == 0 || o.ReadTimeout == 0 || o.WriteTimeout == 0 {
		t.Errorf("超时未设置:dial=%v read=%v write=%v",
			o.DialTimeout, o.ReadTimeout, o.WriteTimeout)
	}
}
