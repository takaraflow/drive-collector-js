package telegram

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"

	"github.com/gotd/td/session"

	"github.com/youngsx/drive-collector/cmd/collector/internal/tgsession"
)

// readOnlyStorage 把 gramjs 的 session 喂给 gotd,永不写回。
//
// 与 shadow 包里那份语义完全相同 —— 影子和生产必须用同一个
// session 存储实现,否则影子验证验证的是两个不同程序。
type readOnlyStorage struct {
	payload []byte
}

func newSessionStorage(s *tgsession.Session) (*readOnlyStorage, error) {
	payload, err := json.Marshal(struct {
		Version int
		Data    session.Data
	}{
		Version: 1, // gotd session.latestVersion
		Data: session.Data{
			DC:        s.DCID,
			Addr:      s.Addr(),
			AuthKey:   s.AuthKey,
			AuthKeyID: s.AuthKeyID(),
		},
	})
	if err != nil {
		return nil, fmt.Errorf("telegram: 编码 session 失败: %w", err)
	}
	return &readOnlyStorage{payload: payload}, nil
}

// LoadSession 返回 gotd 的序列化格式。
func (s *readOnlyStorage) LoadSession(_ context.Context) ([]byte, error) {
	if len(s.payload) == 0 {
		return nil, session.ErrNotFound
	}
	return s.payload, nil
}

// StoreSession 是 no-op。
//
// session 是 Node 侧(或上一个实例)的。写回会让它下次加载到
// 不一致的 authKey → AUTH_KEY_DUPLICATED → 账号被踢下线。
func (s *readOnlyStorage) StoreSession(_ context.Context, _ []byte) error { return nil }

// randRead 是 crypto/rand 的薄封装,便于测试替换。
var randRead = rand.Read
