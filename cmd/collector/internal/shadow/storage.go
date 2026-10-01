package shadow

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/gotd/td/session"

	"github.com/youngsx/drive-collector/cmd/collector/internal/tgsession"
)

// readOnlyJSON 是 gotd session 的磁盘/存储格式。
//
// 直接复用 gotd 自己的 jsonData 布局(Version + Data),而不是猜一个
// 私有格式 —— 格式一变 Loader 就报 version mismatch,早失败比连上
// 一个用错 authKey 的连接安全得多。
type readOnlyJSON struct {
	Version int
	Data    session.Data
}

// ReadOnlyStorage 把 gramjs 的 session 喂给 gotd,永不写回。
//
// 为什么必须只读:session 是 Node 实例的心跳来源。Go 侧一旦真的写回,
// Node 下次加载到的 authKey 就和自己的连接对不上,轻则重连失败,
// 重则触发 AUTH_KEY_DUPLICATED 把线上实例踢下线(记忆里的 PR#445/447)。
//
// 影子模式下 Go 是纯观察者,它的 session 没有留存价值 —— 判断迁移
// 是否安全的依据是「两边看到的 update 流是否一致」,不是 authKey。
type ReadOnlyStorage struct {
	payload []byte
	log     *slog.Logger
	// storeCalls 记录 StoreSession 被调用的次数。测试断言它恒为 0 ——
	// 一旦有人给这个类型加上写逻辑,测试立刻红。
	storeCalls int
}

// NewReadOnlyStorage 把解析好的 gramjs session 转成 gotd 能读的格式。
//
// AuthKeyID 必须由我们算:gramjs 的 StringSession 只保存 dc/addr/port/key,
// 不存 auth_key_id,而 gotd 恢复连接时会校验 `key.Value.ID() != key.ID`,
// 不等就返回 "corrupted key" 失败。留空等于 100% 连不上。
func NewReadOnlyStorage(s *tgsession.Session, log *slog.Logger) (*ReadOnlyStorage, error) {
	if s == nil {
		return nil, tgsession.ErrTooShort
	}
	payload, err := json.Marshal(readOnlyJSON{
		Version: 1, // gotd session.latestVersion
		Data: session.Data{
			DC:        s.DCID,
			Addr:      s.Addr(),
			AuthKey:   s.AuthKey,
			AuthKeyID: s.AuthKeyID(),
		},
	})
	if err != nil {
		return nil, err
	}
	return &ReadOnlyStorage{payload: payload, log: log}, nil
}

// LoadSession 返回 gotd 的序列化格式。
func (s *ReadOnlyStorage) LoadSession(ctx context.Context) ([]byte, error) {
	if len(s.payload) == 0 {
		return nil, session.ErrNotFound
	}
	return s.payload, nil
}

// StoreSession 是 no-op —— 见类型注释。
func (s *ReadOnlyStorage) StoreSession(ctx context.Context, data []byte) error {
	s.storeCalls++
	if s.log != nil {
		// 记一笔:出现这条日志说明 gotd 想持久化 session,是个值得
		// 知道的信号(虽然我们确实什么都不写)。
		s.log.Debug("shadow storage got StoreSession; intentionally ignored")
	}
	return nil
}

// StoreCalls 暴露调用次数,供测试断言。
func (s *ReadOnlyStorage) StoreCalls() int { return s.storeCalls }