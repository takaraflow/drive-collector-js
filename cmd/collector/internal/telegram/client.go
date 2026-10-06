// Package telegram 是 MTProto 客户端层。
//
// shadow 和生产**共用同一个客户端**,区别只有 handler 的行为:
//   - 影子:收到 update 只记指纹,不动手(铁律 2)
//   - 生产:收到 update 真的处理
//
// 为什么共用:影子验证的全部价值就在于「证明同一个客户端在两种
// 模式下的连接行为一致」。连两次(一次影子一次生产)等于验证了
// 两个不同程序,那个结论没有意义。
package telegram

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	gotdlog "github.com/gotd/log"
	"github.com/gotd/td/telegram"
	"github.com/gotd/td/tg"

	"github.com/youngsx/drive-collector/cmd/collector/internal/tgsession"
)

// Update 是归一化后的单条 update。
//
// 不直接暴露 tg.UpdateClass —— 那个类型有几万种变体,业务代码碰
// 它就等于耦合 gotd,将来换库就得重写。归一化成几种语义,
// 业务侧只处理它认识的那几种。
type Update struct {
	// Kind 是归一化后的语义分类。
	Kind Kind
	// Raw 是原始对象,只有需要读具体字段时才用。
	Raw tg.UpdateClass
	// At 是 update 自带的时间戳(消息产生时刻,不是收到时刻)。
	At time.Time
	// Pts 是进度游标 —— 比对两侧流时用来对齐。
	Pts int
}

// Kind 是 update 的归一化分类。
type Kind string

const (
	KindNewMessage    Kind = "new_message"
	KindEditMessage   Kind = "edit_message"
	KindCallbackQuery Kind = "callback_query"
	KindDeleteMessage Kind = "delete_message"
	KindMediaGroup    Kind = "media_group"
	KindOther         Kind = "other"
)

// MessageHandler 处理归一化后的 update。
//
// 影子模式返回 nil 且什么都不做;生产模式返回 error 会让 gotd
// 断开重连 —— 所以业务错误必须在内部消化掉,不能往上抛。
type MessageHandler func(ctx context.Context, u Update) error

// Config 是客户端配置。
type Config struct {
	APIID   int
	APIHash string
	Session *tgsession.Session
	Handler MessageHandler
	Log     *slog.Logger
}

// Client 是 MTProto 客户端。
type Client struct {
	tg  *telegram.Client
	log *slog.Logger

	// self 是登录后的自身身份,发送消息前需要。
	selfID    int64
	username  string
	readyOnce chan struct{}

	// peers 缓存用户的 AccessHash —— 发私聊消息要用它构造 InputPeerUser。
	// 用 InputPeerChat 会得到 400: CHAT_ID_INVALID。
	peers *peerCache
}

// New 构造客户端。此时不连接。
func New(cfg Config) (*Client, error) {
	if cfg.APIID == 0 || cfg.APIHash == "" {
		return nil, fmt.Errorf("telegram: 需要 API_ID / API_HASH")
	}
	if cfg.Session == nil {
		return nil, fmt.Errorf("telegram: 需要已登录的 session")
	}
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}

	storage, err := newSessionStorage(cfg.Session)
	if err != nil {
		return nil, err
	}

	c := &Client{
		log:       cfg.Log,
		readyOnce: make(chan struct{}),
		peers:     newPeerCache(),
	}
	c.tg = telegram.NewClient(cfg.APIID, cfg.APIHash, telegram.Options{
		SessionStorage: storage,
		DC:             cfg.Session.DCID,
		UpdateHandler:  telegram.UpdateHandlerFunc(c.dispatch(cfg.Handler)),
		Logger:         logger{log: cfg.Log},
	})
	return c, nil
}

// Run 连接并阻塞到 ctx 结束。
//
// ctx 取消时必须彻底断开 —— 残留连接会被 Telegram 判为同账号
// 重复登录,把正在服务的另一端踢下线。
func (c *Client) Run(ctx context.Context) error {
	errCh := make(chan error, 1)

	go func() {
		err := c.tg.Run(ctx, func(ctx context.Context) error {
			// 连上后取一次自身身份,发送消息要用。
			if self, serr := c.tg.Self(ctx); serr == nil {
				c.selfID = self.GetID()
				c.username, _ = self.GetUsername()
				close(c.readyOnce)
				c.log.Info("Telegram 已连接",
					"selfId", c.selfID, "username", c.username)
			} else {
				c.log.Warn("取自身身份失败", "err", serr)
			}
			<-ctx.Done()
			return ctx.Err()
		})
		if err != nil && ctx.Err() == nil {
			errCh <- fmt.Errorf("telegram: 连接失败: %w", err)
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		return nil
	}
}

// dispatch 把 gotd 的原始 update 归一化后交给业务 handler。
//
// 归一化在这里做,而不是散落各处 —— gotd 会把 updateShortMessage
// 预先转成 UpdateShort 包 UpdateNewMessage,不归一化的话同一类消息
// 在不同路径上会走出不同的分类。
func (c *Client) dispatch(h MessageHandler) telegram.UpdateHandlerFunc {
	return func(ctx context.Context, u tg.UpdatesClass) error {
		switch v := u.(type) {
		case *tg.UpdateShort:
			c.emit(ctx, h, v.Update, int(v.Date))
			return nil
		case *tg.Updates:
			// 容器里带着 Users —— 顺手记下 AccessHash,后面发消息要用。
			// 这条路径是免费的:消息本来就带过来,不额外花 RPC。
			c.peers.store(v.Users)
			for _, uu := range v.Updates {
				c.emit(ctx, h, uu, int(v.Date))
			}
			return nil
		case *tg.UpdatesCombined:
			c.peers.store(v.Users)
			for _, uu := range v.Updates {
				c.emit(ctx, h, uu, int(v.Date))
			}
			return nil
		default:
			// default 是「收到了但我不知道怎么处理」—— 恰恰最需要留痕,
			// 静默丢弃会让消息凭空消失,而排查时看不出任何异常。
			//
			// 两个已知形态必须看得见:
			//   UpdatesTooLong         服务端判定客户端落后太多,已丢弃部分 update
			//   UpdateShortSentMessage 自己发出去的消息的回执
			//                          (gotd 的 SendMessage 末尾会走回 processUpdates)
			switch u.(type) {
			case *tg.UpdatesTooLong:
				c.log.Warn("收到 UpdatesTooLong —— 服务端已丢弃部分 update",
					"hint", "客户端 pts 落后,后续消息会持续丢失直到重新同步")
			case *tg.UpdateShortSentMessage:
				c.log.Info("已发送消息的回执", "kind", u.TypeName())
			default:
				c.log.Debug("未识别的 update 容器", "kind", u.TypeName())
			}
			return nil
		}
	}
}

func (c *Client) emit(ctx context.Context, h MessageHandler, u tg.UpdateClass, date int) {
	if u == nil || h == nil {
		return
	}
	upd := Update{
		Kind: classify(u),
		Raw:  u,
		At:   time.Unix(int64(date), 0).UTC(),
		Pts:  ptsOf(u),
	}
	// handler 的错误不让它冒到 gotd —— 那会让客户端断开重连,
	// 而影子验证最怕的就是「流出现空洞导致比对失真」。
	if err := h(ctx, upd); err != nil {
		c.log.Warn("update 处理出错(已忽略,不触发重连)",
			"kind", upd.Kind, "err", err)
	}
}

// classify 把具体类型映射到语义分类。
func classify(u tg.UpdateClass) Kind {
	switch v := u.(type) {
	case *tg.UpdateNewMessage:
		if groupedID(v.Message) != 0 {
			return KindMediaGroup
		}
		return KindNewMessage
	case *tg.UpdateNewChannelMessage:
		if groupedID(v.Message) != 0 {
			return KindMediaGroup
		}
		return KindNewMessage
	case *tg.UpdateEditMessage:
		return KindEditMessage
	case *tg.UpdateEditChannelMessage:
		return KindEditMessage
	case *tg.UpdateBotCallbackQuery:
		return KindCallbackQuery
	case *tg.UpdateDeleteMessages:
		return KindDeleteMessage
	default:
		return KindOther
	}
}

// groupedID 取消息的媒体组 ID。
//
// MessageClass 接口只暴露 GetID,getter 都在具体类型上 —— 所以必须
// 断言到 *tg.Message。断言失败(空消息等)返回 0,意为「非媒体组」。
func groupedID(m tg.MessageClass) int64 {
	if msg, ok := m.(*tg.Message); ok {
		gid, _ := msg.GetGroupedID()
		return gid
	}
	return 0
}

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

// SelfID 返回登录账号的 ID,未连接时为 0。
func (c *Client) SelfID() int64 { return c.selfID }

// SendMessage 给指定 chat 发文本消息。
//
// 不自己生成 RandomID —— gotd 在 RandomID==0 时会用 RandInt64 生成,
// 自己造反而可能和它的实现不一致。
func (c *Client) SendMessage(ctx context.Context, chatID int64, text string) error {
	peer, err := c.peerFor(ctx, chatID)
	if err != nil {
		return err
	}
	req := &tg.MessagesSendMessageRequest{
		Peer:    peer,
		Message: text,
	}
	if err := c.tg.SendMessage(ctx, req); err != nil {
		return fmt.Errorf("telegram: 发送消息失败(chat=%d): %w", chatID, err)
	}
	return nil
}

// SendMessageWithID 发消息并返回消息 id —— /files 的占位消息要拿
// 它做后续编辑。
//
// 不走 gotd 的 SendMessage 便捷方法:它把响应扔了,拿不到 id。
// 也不调 processUpdates —— 那会把这条消息的回声派发回入口,
// 入口再丢一次;不派发等于少一趟「自己回自己」的噪音。
func (c *Client) SendMessageWithID(ctx context.Context, chatID int64, text string) (int, error) {
	peer, err := c.peerFor(ctx, chatID)
	if err != nil {
		return 0, err
	}
	req := &tg.MessagesSendMessageRequest{Peer: peer, Message: text}
	if req.RandomID == 0 {
		id, err := c.tg.RandInt64()
		if err != nil {
			return 0, err
		}
		req.RandomID = id
	}
	updates, err := c.tg.API().MessagesSendMessage(ctx, req)
	if err != nil {
		return 0, fmt.Errorf("telegram: 发送消息失败(chat=%d): %w", chatID, err)
	}
	return messageIDOf(updates), nil
}

// messageIDOf 从发送回执里挖出新消息的 id。
//
// 回执形态因聊天类型而异:私聊常见 UpdateShortSentMessage,其他情况
// 包在 Updates 容器里(UpdateMessageID 或 UpdateNewMessage)。
// 挖不到返回 0 —— 调用方只能放弃编辑,不能放弃发送结果。
func messageIDOf(u tg.UpdatesClass) int {
	switch v := u.(type) {
	case *tg.UpdateShortSentMessage:
		return v.ID
	case *tg.Updates:
		return messageIDFromUpdates(v.Updates)
	case *tg.UpdatesCombined:
		return messageIDFromUpdates(v.Updates)
	}
	return 0
}

func messageIDFromUpdates(list []tg.UpdateClass) int {
	for _, uu := range list {
		switch v := uu.(type) {
		case *tg.UpdateMessageID:
			return v.ID
		case *tg.UpdateNewMessage:
			if m, ok := v.Message.(*tg.Message); ok {
				return m.ID
			}
		}
	}
	return 0
}

// EditMessage 改掉已有消息 —— 用户体验上「进度条在同一行更新」。
//
// 返回值里可能有 MessageClass 也可能没有(消息被删了),所以只看错误码。
func (c *Client) EditMessage(ctx context.Context, chatID int64, msgID int, text string) error {
	peer, err := c.peerFor(ctx, chatID)
	if err != nil {
		return err
	}
	// 走 gotd 生成的方法:它自己知道 messages.editMessage 返回 Updates。
	// 手写 result(以前写的是 MessagesAffectedMessages)会让【每一次】
	// 编辑都失败,而 sendMessage 正常 —— 症状是「/files 一直转圈」。
	if _, err := c.tg.API().MessagesEditMessage(ctx, &tg.MessagesEditMessageRequest{
		Peer:    peer,
		ID:      msgID,
		Message: text,
	}); err != nil {
		return fmt.Errorf("telegram: 编辑消息失败(chat=%d msg=%d): %w", chatID, msgID, err)
	}
	return nil
}

// SendProgress 上报任务进度。
//
// 单独一个方法而不是让调用方拼字符串:进度格式一旦分散到各处,
// 很快就会出现「有的地方写 45%、有的地方写 0.45」的不一致,
// 而用户会直接看到。
func (c *Client) SendProgress(ctx context.Context, chatID int64, fileName string, ratio float64) error {
	if ratio < 0 {
		ratio = 0
	}
	if ratio > 1 {
		ratio = 1
	}
	pct := int(ratio * 100)
	bar := progressBar(ratio, 20)
	text := fmt.Sprintf("%s\n%s %d%%", fileName, bar, pct)
	return c.SendMessage(ctx, chatID, text)
}

// progressBar 渲染进度条。
func progressBar(ratio float64, width int) string {
	filled := int(ratio * float64(width))
	if filled < 0 {
		filled = 0
	}
	if filled > width {
		filled = width
	}
	return "[" + strings.Repeat("█", filled) + strings.Repeat("░", width-filled) + "]"
}

// randomID 生成消息随机 ID。
//
// Telegram 用它做去重:同一条消息重发时带上同一个 ID,服务端会
// 丢弃重复。必须够随机 —— 撞了会导致别人的消息被吞掉。
func randomID() int64 {
	var b [8]byte
	// crypto/rand 失败时退化为时间戳 —— 这个字段不涉及安全,
	// 只涉及去重,时间戳的区分度够用。
	if _, err := randRead(b[:]); err != nil {
		return time.Now().UnixNano()
	}
	return int64(b[0])<<56 | int64(b[1])<<48 | int64(b[2])<<40 | int64(b[3])<<32 |
		int64(b[4])<<24 | int64(b[5])<<16 | int64(b[6])<<8 | int64(b[7])<<1
}

// logger 把 gotd 日志接到 slog。
type logger struct{ log *slog.Logger }

func (l logger) Enabled(ctx context.Context, lv gotdlog.Level) bool {
	return l.log.Enabled(ctx, mapLevel(lv))
}

func (l logger) Log(ctx context.Context, lv gotdlog.Level, msg string, attrs ...gotdlog.Attr) {
	l.log.Log(ctx, mapLevel(lv), "gotd: "+msg)
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
