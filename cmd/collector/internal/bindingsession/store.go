// Package bindingsession 管理绑定向导的会话状态。
//
// JS 侧 SessionManager 存 KV(cache:session:<userId>,24h TTL)。
// Go worker 手里只有 Redis,存这里。key 与 JS 一致 —— 切换期两边
// 可能同时在跑,JS 写的会话 Go 要能读。
package bindingsession

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// TTL 是会话过期时间。与 JS 侧 86400 秒一致。
const TTL = 24 * time.Hour

// Session 是一次绑定会话。
//
// 与 JS SessionManager.start 写入的结构字段一一对应 —— key 一致
// 之外,值结构也得一致,不然 JS 写的会话 Go 解不开。
type Session struct {
	UserID      string `json:"user_id"`
	CurrentStep string `json:"current_step"`
	// TempData 是步骤间累积的凭据(URL/用户名/密码...)。
	// JS 存 JSON 字符串,这里保持一致:序列化后原样存。
	TempData string `json:"temp_data"`
	// Data 是 TempData 解开后的视图,只在内存里用,不落盘。
	Data map[string]string `json:"-"`
	// UpdatedAt 是毫秒时间戳,与 JS 侧一致。
	UpdatedAt int64 `json:"updated_at"`
}

// Store 是 Redis 会话存储。
type Store struct {
	rdb redis.UniversalClient
}

// NewStore 构造会话存储。
func NewStore(rdb redis.UniversalClient) *Store { return &Store{rdb: rdb} }

// key 与 JS 侧 CACHE_KEYS.session 完全一致。
func key(userID string) string { return "session:" + userID }

// Get 取会话。没有会话返回 (nil, nil),调用方按「无绑定会话」处理。
func (s *Store) Get(ctx context.Context, userID string) (*Session, error) {
	raw, err := s.rdb.Get(ctx, key(userID)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("bindingsession: 读会话失败: %w", err)
	}
	var sess Session
	if err := json.Unmarshal([]byte(raw), &sess); err != nil {
		return nil, fmt.Errorf("bindingsession: 会话不是合法 JSON: %w", err)
	}
	// TempData 里存的是 JSON 字符串(JS 侧 serializeDriveSessionData),解开它。
	if sess.TempData != "" {
		var data map[string]string
		if err := json.Unmarshal([]byte(sess.TempData), &data); err == nil {
			sess.Data = data
		}
	}
	if sess.Data == nil {
		sess.Data = map[string]string{}
	}
	return &sess, nil
}

// Start 开启新会话(覆盖旧的)。
func (s *Store) Start(ctx context.Context, userID, step string, data map[string]string) error {
	sess := Session{
		UserID:      userID,
		CurrentStep: step,
		Data:        data,
	}
	if sess.Data == nil {
		sess.Data = map[string]string{}
	}
	return s.set(ctx, &sess)
}

// Update 更新步骤与累积数据。与 JS 侧一致:在旧数据上合并。
func (s *Store) Update(ctx context.Context, userID, step string, newData map[string]string) error {
	sess, err := s.Get(ctx, userID)
	if err != nil {
		return err
	}
	if sess == nil {
		return fmt.Errorf("bindingsession: 用户 %s 没有进行中的会话", userID)
	}
	for k, v := range newData {
		sess.Data[k] = v
	}
	sess.CurrentStep = step
	return s.set(ctx, sess)
}

// Clear 结束会话。
func (s *Store) Clear(ctx context.Context, userID string) error {
	if err := s.rdb.Del(ctx, key(userID)).Err(); err != nil {
		return fmt.Errorf("bindingsession: 删会话失败: %w", err)
	}
	return nil
}

func (s *Store) set(ctx context.Context, sess *Session) error {
	blob, err := json.Marshal(sess.Data)
	if err != nil {
		return fmt.Errorf("bindingsession: 序列化数据失败: %w", err)
	}
	sess.TempData = string(blob)
	sess.UpdatedAt = time.Now().UnixMilli()
	raw, err := json.Marshal(sess)
	if err != nil {
		return fmt.Errorf("bindingsession: 序列化会话失败: %w", err)
	}
	if err := s.rdb.Set(ctx, key(sess.UserID), raw, TTL).Err(); err != nil {
		return fmt.Errorf("bindingsession: 写会话失败: %w", err)
	}
	return nil
}
