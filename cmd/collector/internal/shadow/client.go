package shadow

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	gotdlog "github.com/gotd/log"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"

	"github.com/youngsx/drive-collector/cmd/collector/internal/shadowfingerprint"
	"github.com/youngsx/drive-collector/cmd/collector/internal/tgsession"
)

// Client 是影子模式的 Telegram 客户端。
//
// 它连上 Telegram、收到 update、记一笔,然后丢弃。不处理任何消息。
type Client struct {
	tg       *telegram.Client
	observer *Observer
	log      *slog.Logger
}

// Config 是影子客户端配置。
type Config struct {
	APIID   int
	APIHash string
	// Session 是从 Node 侧 session 解析出来的登录态。
	Session *tgsession.Session
	Log     *slog.Logger
	// Observer 可注入,便于测试。
	Observer *Observer
}

// New 构造影子客户端。此时尚未连接。
func New(cfg Config) (*Client, error) {
	if cfg.APIID == 0 || cfg.APIHash == "" {
		return nil, fmt.Errorf("影子模式需要 API_ID / API_HASH")
	}
	if cfg.Session == nil {
		return nil, fmt.Errorf("影子模式需要已登录的 session")
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.Observer == nil {
		cfg.Observer = NewObserver(cfg.Log)
	}

	storage, err := NewReadOnlyStorage(cfg.Session, cfg.Log)
	if err != nil {
		return nil, err
	}

	c := &Client{observer: cfg.Observer, log: cfg.Log}
	c.tg = telegram.NewClient(cfg.APIID, cfg.APIHash, telegram.Options{
		SessionStorage: storage,
		DC:             cfg.Session.DCID,
		UpdateHandler:  telegram.UpdateHandlerFunc(c.onUpdate),
		Logger:         gotdLogger{log: cfg.Log},
	})

	return c, nil
}

// Run 连接并在 ctx 结束时断开。
//
// 这是唯一会真正连 Telegram 的地方。ctx 取消 = 断开,不留残余连接 ——
// 残余连接会被 Telegram 判为同账号重复登录。
func (c *Client) Run(ctx context.Context) error {
	c.log.Info("shadow: connecting to Telegram", "mode", "read-only")

	err := c.tg.Run(ctx, func(ctx context.Context) error {
		// 阻塞直到 ctx 取消。Run 在连接建立后调用本函数;
		// 影子模式不需要做任何事 —— 观察靠 UpdateHandler。
		<-ctx.Done()
		return ctx.Err()
	})

	if err != nil && ctx.Err() == nil {
		return fmt.Errorf("影子连接失败: %w", err)
	}
	return nil
}

// Observer 暴露观察器,供调试端点读取摘要。
func (c *Client) Observer() *Observer { return c.observer }

// onUpdate 收到 update 时只记录,不处理。
//
// 铁律 2:这里绝不能出现任何有副作用的 API 调用。
// 只要这个函数还恒返回 nil,影子模式就是安全的。
func (c *Client) onUpdate(ctx context.Context, u tg.UpdatesClass) error {
	if u == nil {
		return nil
	}

	switch v := u.(type) {
	case *tg.UpdateShort:
		// 单条 update 直接记录。
		c.record(v.Update, v.Date)

	case *tg.Updates:
		// 批次必须拆成单条再记录。gramjs 的 addEventHandler 是逐条回调
		// (收到 Api.UpdateNewMessage),gotd 收到的是 tg.Updates 包装 ——
		// 不拆的话 Go 记「Updates×1」Node 记「UpdateNewMessage×N」,
		// diff 全红,比对彻底失去意义。
		for _, uu := range v.Updates {
			c.record(uu, v.Date)
		}

	case *tg.UpdatesCombined:
		for _, uu := range v.Updates {
			c.record(uu, v.Date)
		}

	case *tg.UpdatesTooLong:
		// 流被截断重拉:该时段 Node 侧也会重拉,构成不可比。
		// 显式告警,否则会拿着残缺的流判定「不一致」。
		// (该结构体是空的 —— pts 存在外层 UpdatesState。)
		c.log.Warn("shadow: update 流被截断重拉 —— 该时段比对结果不可信")

	default:
		c.log.Debug("shadow: 未识别的 update 容器", "kind", u.TypeName())
	}

	// 恒返回 nil:影子模式不因单条 update 失败而中断。
	return nil
}

// record 记录单条 update。这是真正与 Node 侧对齐的粒度。
func (c *Client) record(u tg.UpdateClass, date int) {
	if u == nil {
		return
	}
	obs := Observation{
		// 用 update 自带的时间戳,不是 time.Now()。前者是「消息什么时候
		// 产生的」,跨语言可比;后者是「我们什么时候收到的」,带网络延迟,
		// 而 Node 侧根本没有「收到时刻」这个概念 —— 拿它分桶会让两侧的
		// 窗口边界对不齐。
		At:      time.Unix(int64(date), 0).UTC(),
		Kind:    u.TypeName(),
		Date:    date,
		Session: ptsOf(u),
	}
	applyFeature(&obs.Feature, u)
	c.observer.Record(obs)
}

// applyFeature 从单条 update 提取跨语言共享的指纹特征。
//
// 只取 Node 侧也算得出来的量 —— gramjs 的 update 对象有同样的
// message / media / groupedId 字段。
func applyFeature(f *shadowfingerprint.Observation, u tg.UpdateClass) {
	// 用 tg.UpdateClass 自带的 TypeID() —— 早先手写了一个 6 项的
	// typeIDOf switch,其余所有 update(打字状态、已读历史、频道网页
	// 预览……,占实际流量绝大多数)全落进 default: return 0,被压成
	// t=00000000 这一个桶,而 Node 侧记的是各自的真实 ID。
	// 结果是 diff 里凭空多出一整类 Go 侧噪声。
	f.TypeID = shadowfingerprint.NormalizeTypeID(u.TypeID())

	switch v := u.(type) {
	case *tg.UpdateNewMessage:
		applyMessage(f, v.Message)
	case *tg.UpdateNewChannelMessage:
		applyMessage(f, v.Message)
	case *tg.UpdateEditMessage:
		applyMessage(f, v.Message)
	case *tg.UpdateEditChannelMessage:
		applyMessage(f, v.Message)
	default:
		// 非消息类 update(权限变更、命令列表变更等)没有可提取特征,
		// 留空即可 —— TypeID 本身已经足够区分。
	}
}

// applyMessage 提取消息类 update 的指纹特征。
func applyMessage(f *shadowfingerprint.Observation, m tg.MessageClass) {
	if msg, ok := m.(*tg.Message); ok {
		f.HasMedia = msg.Media != nil
		f.TextLen = len(msg.Message)
		f.GroupID = groupIDOf(msg.GroupedID)
	}
	// MessageEmpty 没有内容 —— gramjs 侧同样提取不到,留空即可。
}

// groupIDOf 把 groupedID 归一成指纹里的字符串。
// gotd 的 Message.GroupedID 是 int64,0 表示「非媒体组」。
func groupIDOf(id int64) string {
	if id == 0 {
		return ""
	}
	return strconv.FormatInt(id, 10)
}

// ptsOf 取 update 的 pts —— 两边比对时的进度游标。
func ptsOf(u tg.UpdateClass) int {
	switch v := u.(type) {
	case *tg.UpdateNewMessage:
		return v.Pts
	case *tg.UpdateNewChannelMessage:
		return v.Pts
	case *tg.UpdateDeleteMessages:
		return v.Pts
	default:
		return 0
	}
}

// gotdLogger 把 gotd 日志接到 slog,避免两套格式。
type gotdLogger struct{ log *slog.Logger }

func (g gotdLogger) Enabled(ctx context.Context, level gotdlog.Level) bool {
	return g.log.Enabled(ctx, mapLevel(level))
}

func (g gotdLogger) Log(ctx context.Context, level gotdlog.Level, msg string, attrs ...gotdlog.Attr) {
	g.log.Log(ctx, mapLevel(level), "gotd: "+msg)
}

func mapLevel(l gotdlog.Level) slog.Level {
	switch l {
	case gotdlog.LevelError:
		return slog.LevelError
	case gotdlog.LevelWarn:
		return slog.LevelWarn
	case gotdlog.LevelInfo:
		return slog.LevelInfo
	default:
		return slog.LevelDebug
	}
}