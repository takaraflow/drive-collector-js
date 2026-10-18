package telegram

import (
	"context"
	"fmt"
	"sync"

	"github.com/gotd/td/tg"
	"github.com/gotd/td/tgerr"
)

// peerCache 记住用户与频道的 AccessHash。
//
// 为什么需要:给私聊用户发消息要用 `InputPeerUser{UserID, AccessHash}`,
// 访问频道消息要用 `InputChannel{ChannelID, AccessHash}`。
// 用错误的 Peer 类型或缺少 AccessHash 会得到 CHAT_ID_INVALID 或 CHANNEL_INVALID。
type peerCache struct {
	mu       sync.RWMutex
	users    map[int64]int64 // userID → accessHash
	channels map[int64]int64 // channelID → accessHash
}

func newPeerCache() *peerCache {
	return &peerCache{
		users:    map[int64]int64{},
		channels: map[int64]int64{},
	}
}

// store 记下服务端下发的用户。
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

// storeChannels 记下服务端下发的频道 accessHash。
func (p *peerCache) storeChannels(chats []tg.ChatClass) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range chats {
		if ch, ok := c.(*tg.Channel); ok && ch.ID != 0 {
			if hash, ok := ch.GetAccessHash(); ok {
				p.channels[ch.ID] = hash
			}
		}
	}
}

// storeChannel 记名单条频道的 accessHash。
func (p *peerCache) storeChannel(channelID, accessHash int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.channels[channelID] = accessHash
}

func (p *peerCache) getChannel(channelID int64) (int64, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	h, ok := p.channels[channelID]
	return h, ok
}

// StoreChannelPeer 显式记录频道的 accessHash，供下载或重试时直接寻址。
func (c *Client) StoreChannelPeer(channelID, accessHash int64) {
	if c.peers != nil {
		c.peers.storeChannel(channelID, accessHash)
	}
}

// peerFor 解析出可用的 InputPeer。
//
// 三种情况:
//   - 用户私聊(正数):缓存命中 AccessHash，或向服务端问一次
//   - 频道/超级群(负数且以 -100 开头):缓存命中频道 AccessHash，构造 InputPeerChannel
//   - 普通群聊(普通负数):退化为 InputPeerChat
func (c *Client) peerFor(ctx context.Context, chatID int64) (tg.InputPeerClass, error) {
	if chatID < 0 {
		if chID, isChannel := ParseChannelID(chatID); isChannel {
			if hash, ok := c.peers.getChannel(chID); ok {
				return &tg.InputPeerChannel{ChannelID: chID, AccessHash: hash}, nil
			}
			return nil, fmt.Errorf("telegram: 缺少频道 %d 的 accessHash", chID)
		}
		return &tg.InputPeerChat{ChatID: -chatID}, nil
	}

	if hash, ok := c.peers.get(chatID); ok {
		return &tg.InputPeerUser{UserID: chatID, AccessHash: hash}, nil
	}

	// 缓存未命中:向服务端问。这是每条对话【第一次】发消息才会走的分支。
	hash, err := c.fetchAccessHash(ctx, chatID)
	if err != nil {
		return nil, err
	}
	return &tg.InputPeerUser{UserID: chatID, AccessHash: hash}, nil
}

// fetchAccessHash 向服务端要一次用户的 AccessHash。
func (c *Client) fetchAccessHash(ctx context.Context, userID int64) (int64, error) {
	res, err := c.tg.API().MessagesGetPeerDialogs(ctx, []tg.InputDialogPeerClass{
		&tg.InputDialogPeer{Peer: &tg.InputPeerUser{UserID: userID}},
	})
	if err != nil {
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
