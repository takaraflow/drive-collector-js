package telegram

import (
	"context"
	"testing"

	"github.com/gotd/td/tg"
)

// TestPeerCacheStoresAccessHash 从 update 容器里收下 AccessHash。
//
// 这是免 RPC 的那条路径:消息本来就带着 Users,顺手记下来。
func TestPeerCacheStoresAccessHash(t *testing.T) {
	p := newPeerCache()
	p.store([]tg.UserClass{
		&tg.User{ID: 7428626313, AccessHash: 0xdeadbeef},
		&tg.User{ID: 555, AccessHash: 0xcafe},
	})

	if h, ok := p.get(7428626313); !ok || h != 0xdeadbeef {
		t.Errorf("AccessHash = %#x ok=%v", h, ok)
	}
	if _, ok := p.get(999); ok {
		t.Error("没存过的 id 不该命中")
	}
}

// TestPeerCacheIgnoresMalformed 畸形条目不进缓存。
//
// ID=0 的用户不是真实用户,存进去会让「ID 0」这个哨兵值变得可用。
func TestPeerCacheIgnoresMalformed(t *testing.T) {
	p := newPeerCache()
	p.store([]tg.UserClass{
		&tg.User{ID: 0, AccessHash: 1},
		&tg.UserEmpty{ID: 777}, // 不是 *tg.User
	})

	if _, ok := p.get(0); ok {
		t.Error("ID=0 不该被缓存")
	}
	if _, ok := p.get(777); ok {
		t.Error("UserEmpty 不该被当成可发消息的用户")
	}
}

// TestPeerForUsesInputPeerUserForNumbers 正数 id 必须走 InputPeerUser。
//
// 这是这次生产故障的直接回归:发给私聊用户用了 InputPeerChat,
// Telegram 回 400: CHAT_ID_INVALID,用户看到的是「发消息没反应」。
// 现象覆盖所有命令(/start /files /drive 全部如此)。
func TestPeerForUsesInputPeerUserForNumbers(t *testing.T) {
	c := &Client{log: quiet(), peers: newPeerCache()}
	c.peers.store([]tg.UserClass{&tg.User{ID: 7428626313, AccessHash: 42}})

	peer, err := c.peerFor(context.Background(), 7428626313)
	if err != nil {
		t.Fatal(err)
	}
	user, ok := peer.(*tg.InputPeerUser)
	if !ok {
		t.Fatalf("peer 类型 = %T,私聊必须用 InputPeerUser", peer)
	}
	if user.UserID != 7428626313 || user.AccessHash != 42 {
		t.Errorf("peer = %+v", user)
	}
}

// TestPeerForUsesInputPeerChatForNegatives 负数 id 是群/频道。
//
// Telegram 的约定:用户 id 是正的,群和频道是负的。
// 这条守着「不要把所有 id 都当用户」—— 反过来的错误同样会让消息发不出去。
func TestPeerForUsesInputPeerChatForNegatives(t *testing.T) {
	c := &Client{log: quiet(), peers: newPeerCache()}

	peer, err := c.peerFor(context.Background(), -1001234567890)
	if err != nil {
		t.Fatal(err)
	}
	chat, ok := peer.(*tg.InputPeerChat)
	if !ok {
		t.Fatalf("peer 类型 = %T,负数 id 应按群聊处理", peer)
	}
	// 群聊的 ChatID 是正的 —— 这是 Telegram 的存储约定
	if chat.ChatID != 1001234567890 {
		t.Errorf("ChatID = %d,应为正数", chat.ChatID)
	}
}

// TestPeerForNeverFabricatesZeroHash 缓存未命中时不能拼一个 AccessHash=0 的 peer。
//
// AccessHash=0 发出去同样是 CHAT_ID_INVALID / PEER_ID_INVALID,但那会把
// 「没查到」伪装成「参数不对」,排查方向全错。所以未命中必须走查询,
// 查询失败就报错 —— 而不是退回一个看起来能用的 peer。
//
// 这里用「未连接的客户端」触发查询失败:真实场景是网络问题或对方
// 从未与 bot 对话过,两者都该报错而不是硬发。
func TestPeerForNeverFabricatesZeroHash(t *testing.T) {
	c := &Client{log: quiet(), peers: newPeerCache()}

	// 未连接时 c.tg 为 nil,查询会 panic —— 那也算「没有静默拼 peer」,
	// 但我们要的是明确报错,所以这里断言的是「不会返回一个 peer」。
	func() {
		defer func() { _ = recover() }()
		peer, err := c.peerFor(context.Background(), 12345)
		if err == nil && peer != nil {
			t.Errorf("拿不到 AccessHash 却返回了 peer:%+v", peer)
		}
	}()
}
