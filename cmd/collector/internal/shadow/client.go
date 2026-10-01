package shadow

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	gotdlog "github.com/gotd/log"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"

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
	c.log.Info("shadow: connecting to Telegram",
		"dc", c.tg != nil, "mode", "read-only")

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

	obs := Observation{
		At:   time.Now().UTC(),
		Kind: u.TypeName(),
	}

	switch v := u.(type) {
	case *tg.UpdateShort:
		obs.UpdateType = "UpdateShort"
		obs.Date = v.Date
		obs.Points = 1
	case *tg.Updates:
		obs.UpdateType = "Updates"
		obs.Points = len(v.Updates)
		if len(v.Updates) > 0 {
			obs.SessionID = ptsOf(v.Updates[0])
		}
	case *tg.UpdatesCombined:
		obs.UpdateType = "UpdatesCombined"
		obs.Points = len(v.Updates)
		if len(v.Updates) > 0 {
			obs.SessionID = ptsOf(v.Updates[0])
		}
	case *tg.UpdatesTooLong:
		// 流被截断重拉:比对结果在这一段不完整,必须显式记录,
		// 否则我们会拿一段残缺的流去和 Node 比,并错误地判定「不一致」。
		// (该结构体本身是空的 —— pts 存在外层 UpdatesState。)
		obs.UpdateType = "UpdatesTooLong"
		c.log.Warn("shadow: update 流被截断重拉 —— 该时段比对结果不可信")
	default:
		obs.UpdateType = u.TypeName()
		obs.Points = 1
	}

	c.observer.Record(obs)

	// 恒返回 nil:影子模式不因单条 update 失败而中断。
	return nil
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