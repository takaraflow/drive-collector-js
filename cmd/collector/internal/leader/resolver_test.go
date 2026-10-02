package leader

import (
	"context"
	"errors"
	"testing"
)

type stubResolver struct {
	lock  []byte
	lerr  error
	list  []Instance
	lerr2 error
}

func (s stubResolver) LockGetter(context.Context, string) ([]byte, error) { return s.lock, s.lerr }
func (s stubResolver) ActiveLister(context.Context) ([]Instance, error)   { return s.list, s.lerr2 }

func TestBaseURL(t *testing.T) {
	cases := []struct {
		name string
		r    Resolver
		want string
	}{
		{
			name: "取 directUrl",
			r: Resolver{
				LockGetter: stubResolver{lock: []byte(`{"instanceId":"i1"}`)}.LockGetter,
				ActiveLister: stubResolver{list: []Instance{
					{ID: "i1", DirectURL: "https://direct.example.com/", URL: "https://fallback.example.com"},
				}}.ActiveLister,
			},
			want: "https://direct.example.com",
		},
		{
			name: "无 directUrl 时回退 url",
			r: Resolver{
				LockGetter: stubResolver{lock: []byte(`{"instanceId":"i1"}`)}.LockGetter,
				ActiveLister: stubResolver{list: []Instance{
					{ID: "i1", URL: "http://internal:7860"},
				}}.ActiveLister,
			},
			want: "http://internal:7860",
		},
		{
			name: "锁为空 → 无 leader",
			r: Resolver{
				LockGetter:   stubResolver{lock: nil}.LockGetter,
				ActiveLister: stubResolver{list: []Instance{{ID: "i1", DirectURL: "https://x.example.com"}}}.ActiveLister,
			},
			want: "",
		},
		{
			name: "锁里没 instanceId → 无 leader",
			r: Resolver{
				LockGetter:   stubResolver{lock: []byte(`{}`)}.LockGetter,
				ActiveLister: stubResolver{list: []Instance{{ID: "i1", DirectURL: "https://x.example.com"}}}.ActiveLister,
			},
			want: "",
		},
		{
			name: "锁 JSON 损坏 → 降级而非崩溃",
			r: Resolver{
				LockGetter:   stubResolver{lock: []byte(`{bad`)}.LockGetter,
				ActiveLister: stubResolver{list: []Instance{}}.ActiveLister,
			},
			want: "",
		},
		{
			name: "持锁实例不在活跃列表 → 无 leader",
			r: Resolver{
				LockGetter: stubResolver{lock: []byte(`{"instanceId":"gone"}`)}.LockGetter,
				ActiveLister: stubResolver{list: []Instance{
					{ID: "other", DirectURL: "https://other.example.com"},
				}}.ActiveLister,
			},
			want: "",
		},
		{
			name: "Redis 读失败 → 降级(不是错误)",
			r: Resolver{
				LockGetter:   stubResolver{lerr: errors.New("connection refused")}.LockGetter,
				ActiveLister: stubResolver{list: []Instance{}}.ActiveLister,
			},
			want: "",
		},
		{
			name: "未装配依赖 → 无 leader",
			r:    Resolver{},
			want: "",
		},
		{
			name: "非 http(s) URL 被拒",
			r: Resolver{
				LockGetter: stubResolver{lock: []byte(`{"instanceId":"i1"}`)}.LockGetter,
				ActiveLister: stubResolver{list: []Instance{
					{ID: "i1", DirectURL: "file:///etc/passwd"},
				}}.ActiveLister,
			},
			want: "",
		},
		{
			name: "相对 URL 被拒",
			r: Resolver{
				LockGetter: stubResolver{lock: []byte(`{"instanceId":"i1"}`)}.LockGetter,
				ActiveLister: stubResolver{list: []Instance{
					{ID: "i1", DirectURL: "/api/v2/tasks"},
				}}.ActiveLister,
			},
			want: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := tc.r.BaseURL(context.Background())
			if err != nil {
				t.Fatalf("不应返回错误(降级是正常状态),得到 %v", err)
			}
			if got != tc.want {
				t.Errorf("BaseURL = %q,期望 %q", got, tc.want)
			}
		})
	}
}

// TestLockKeyMatchesJS 锁的 key 必须与 JS 侧一致,否则读不到持锁者。
func TestLockKeyMatchesJS(t *testing.T) {
	if LockKey != "lock:telegram_client" {
		t.Errorf("LockKey = %q,与 src/domain/cache-keys.js 不一致", LockKey)
	}
}

// TestInstancePrefixMatchesJS 实例 key 前缀必须与 JS 侧一致。
func TestInstancePrefixMatchesJS(t *testing.T) {
	if instancePrefix != "instance:" {
		t.Errorf("instancePrefix = %q,与 InstanceRepository.PREFIX 不一致", instancePrefix)
	}
}
