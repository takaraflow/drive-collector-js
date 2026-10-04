package telegram

import (
	"context"
	"fmt"
	"sync"

	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// peerCache 记住用户的 AccessHash。
//
// 为什么需要:给私聊用户发消息要用 `InputPeerUser{UserID, AccessHash}`,
// 而 `InputPeerChat{ChatID}` 是【群聊/普通聊天】的形态 —— 拿它去发
// 用户 id 会得到 `400: CHAT_ID_INVALID`,用户看到的是「发消息没反应」。
//
// AccessHash 只能从服务端下发的地方拿到(update 容器的 Users 字段,
// 或 UsersGetUsers 的返回),自己推不出来。
//
// 生产实测:所有命令(/start /files /drive)都报 CHAT_ID_INVALID。
type peerCache struct {
	mu    sync.RWMutex
	users map[int64]int64 // userID → accessHash
}

func newPeerCache() *peerCache {
	return &peerCache{users: map[int64]int64{}}
}

// store 记下服务端下发的用户。
//
// 从 update 容器的 Users 里收 —— 那条路径是免费的(消息本来就带过来),
// 而每次发消息都去问一次服务端是白花一次 RPC。
func (p *peerCache) store(users []tg.UserClass) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, u := range users {
		if user, ok := u.(*tg.User); ok && user.ID != 0 {
			p.users[user.ID] = user.AccessHash
		}
	}
}

func (p *peerCache) get(userID int64) (int64, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	h, ok := p.users[userID]
	return h, ok
}

// peerFor 解析出可用的 InputPeer。
//
// 三种情况:
//   - 缓存里有 AccessHash → 直接用
//   - 群/频道(负数 id)→ 用 InputPeerChat
//   - 都没有 → 向服务端问一次,并记下来
//
// 负数 id 是 Telegram 的约定:群和频道的 id 是负的,用户的 id 是正的。
// 拿正数 id 去构造 InputPeerChat 正是这次故障的直接原因。
func (c *Client) peerFor(ctx context.Context, chatID int64) (tg.InputPeerClass, error) {
	if chatID < 0 {
		// 群 / 频道。这里仍需要 access_hash 才能可靠定位,但
		// InputPeerChat 对普通群聊够用;超级群会退化 —— 见下面的注释。
		return &tg.InputPeerChat{ChatID: -chatID}, nil
	}

	if hash, ok := c.peers.get(chatID); ok {
		return &tg.InputPeerUser{UserID: chatID, AccessHash: hash}, nil
	}

	// 缓存未命中:问服务端。这是每条对话【第一次】发消息才会走的分支。
	hash, err := c.fetchAccessHash(ctx, chatID)
	if err != nil {
		return nil, err
	}
	return &tg.InputPeerUser{UserID: chatID, AccessHash: hash}, nil
}

// fetchAccessHash 向服务端要一次用户的 AccessHash。
//
// 用 MessagesGetPeerDialogs 而不是 UsersGetUsers:后者对 bot 账号
// 常常返回空(隐私限制),而前者只要用户跟 bot 有过对话就一定拿得到 ——
// 我们发消息的前提正是「用户跟 bot 聊过」。
func (c *Client) fetchAccessHash(ctx context.Context, userID int64) (int64, error) {
	res, err := c.tg.API().MessagesGetPeerDialogs(ctx, []tg.InputDialogPeerClass{
		&tg.InputDialogPeer{Peer: &tg.InputPeerUser{UserID: userID}},
	})
	if err != nil {
		// FLOOD_WAIT 之类的瞬时错误值得区分 —— 它不该被当成「用户不存在」。
		if flood, ferr := tgerr.FloodWait(ctx, err); ferr != nil && flood {
			return 0, fmt.Errorf("telegram: 查询用户 %d 被限流,稍后重试", userID)
		}
		return 0, fmt.Errorf("telegram: 查询用户 %d 的 peer 失败: %w", userID, err)
	}

	for _, u := range res.Users {
		if user, ok := u.(*tg.User); ok && user.ID == userID {
			c.peers.store(res.Users)
			return user.AccessHash, nil
		}
	}
	return 0, fmt.Errorf(
		"telegram: 拿不到用户 %d 的 AccessHash —— 对方可能从未与 bot 对话过", userID)
}
