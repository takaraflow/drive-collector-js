package telegram

import (
	"testing"

	"github.com/gotd/td/tg"
)

// privatePhoto 造一条「私聊里没有 from_id 的照片」——
// 这正是 Telegram 在私聊相册里的实际形态。
//
// 少造 from_id 是关键:它让 peer 兜底成为唯一出路,而两处缺陷都藏在
// 「拿不到 from_id 就该怎么办」这个分支里。
func privatePhoto(id int, userID int64) *tg.Message {
	msg := &tg.Message{
		ID:     id,
		PeerID: &tg.PeerUser{UserID: userID},
	}
	msg.SetMedia(&tg.MessageMediaPhoto{
		Photo: &tg.Photo{ID: int64(500 + id), DCID: 4},
	})
	return msg
}

// TestMessageInfoFallsBackToPeerForSenderID 私聊里 from_id 缺失时
// 必须从 peer 兜底出发送者。
//
// 不兜底的后果:media group 任务拿到 user_id=0。门禁查的是 buffer 里
// 的 userID(正确)所以放行,任务建得出来、下载也跑得动,只在上传那一刻
// 才炸 ——「用户 0 没有绑定网盘」,而且只炸相册。
func TestMessageInfoFallsBackToPeerForSenderID(t *testing.T) {
	const userID = int64(7428626313)

	info, ok := messageInfoOf(privatePhoto(101, userID), userID)
	if !ok {
		t.Fatal("合法的消息被丢弃了")
	}
	if info.SenderID != userID {
		t.Fatalf("SenderID = %d,期望 %d —— 私聊里 from_id 不发,必须从 peer 兜底",
			info.SenderID, userID)
	}
}

// TestMessageInfoDoesNotFallbackForOutgoingMessages 自己发出的消息
// 不能从 peer 兜底 —— 它的发送者是 bot 自己,兜底会把 bot 的回复
// 当成用户消息。
func TestMessageInfoDoesNotFallbackForOutgoingMessages(t *testing.T) {
	const userID = int64(7428626313)

	msg := privatePhoto(101, userID)
	msg.SetOut(true)

	info, ok := messageInfoOf(msg, userID)
	if !ok {
		t.Fatal("合法的消息被丢弃了")
	}
	if info.SenderID != 0 {
		t.Errorf("自己发出的消息 SenderID = %d,期望 0 —— 兜底会把 bot 的回复当成用户消息",
			info.SenderID)
	}
}

// TestMessageInfoGivesPhotosDistinctNames 照片没有 fileName,必须编出
// 一个稳定且互不相同的名字。
//
// 编不出来(返回空)的话:sanitize("") 变成 "unnamed",于是【整个相册的
// 每一张都塌成同一个文件名】—— 串行 worker 逐个覆盖,用户发 10 张图
// 网盘上只剩 1 张,而全程不报错、不告警。
func TestMessageInfoGivesPhotosDistinctNames(t *testing.T) {
	const userID = int64(7428626313)

	seen := map[string]bool{}
	for i := 1; i <= 10; i++ {
		info, ok := messageInfoOf(privatePhoto(100+i, userID), userID)
		if !ok {
			t.Fatalf("第 %d 张被丢弃了", i)
		}
		name := info.FileName
		if name == "" || name == "unnamed" {
			t.Fatalf("第 %d 张没有文件名(%q)—— 相册会塌成一个文件", i, name)
		}
		if seen[name] {
			t.Errorf("第 %d 张的文件名与前面重复:%q", i, name)
		}
		seen[name] = true
	}
}

// TestMessageInfoPhotoNameIsStable 同一张照片重发必须得到同一个名字 ——
// 名字每次都变的话去重永远命中不了,同一份内容会反复新传一份。
func TestMessageInfoPhotoNameIsStable(t *testing.T) {
	const userID = int64(7428626313)

	first, _ := messageInfoOf(privatePhoto(101, userID), userID)
	again, _ := messageInfoOf(privatePhoto(101, userID), userID)
	if first.FileName != again.FileName {
		t.Errorf("同一张照片两次得到不同名字:%q vs %q", first.FileName, again.FileName)
	}
}

// TestMessageInfoKeepsDocumentFilename 文档仍用 Telegram 给的真名 ——
// 上面的编名规则只兜底照片/无名文档,不该覆盖真名。
func TestMessageInfoKeepsDocumentFilename(t *testing.T) {
	const userID = int64(7428626313)

	msg := &tg.Message{ID: 7, PeerID: &tg.PeerUser{UserID: userID}}
	msg.SetFromID(&tg.PeerUser{UserID: userID})
	doc := &tg.Document{ID: 99, DCID: 4}
	doc.Attributes = []tg.DocumentAttributeClass{
		&tg.DocumentAttributeFilename{FileName: "报告.pdf"},
	}
	msg.SetMedia(&tg.MessageMediaDocument{Document: doc})

	info, ok := messageInfoOf(msg, userID)
	if !ok {
		t.Fatal("文档消息被丢弃了")
	}
	if info.FileName != "报告.pdf" {
		t.Errorf("FileName = %q,期望 报告.pdf", info.FileName)
	}
}

// TestFileNameOfUnnamedDocument 无名文档也必须编稳定名 —— 无名视频
// 相册与照片同病:空名塌成同一个 unnamed,整组只剩一个文件。
// 扩展名与 JS getMediaInfo 对齐:video 属性 → .mp4,其余 → .bin。
func TestFileNameOfUnnamedDocument(t *testing.T) {
	bare := &tg.Document{ID: 5, DCID: 2}
	if got := fileNameOf(&tg.MessageMediaDocument{Document: bare}); got != "transfer_2_5.bin" {
		t.Errorf("无名文档名 = %q,期望 transfer_2_5.bin", got)
	}

	video := &tg.Document{ID: 6, DCID: 2}
	video.Attributes = []tg.DocumentAttributeClass{&tg.DocumentAttributeVideo{}}
	if got := fileNameOf(&tg.MessageMediaDocument{Document: video}); got != "transfer_2_6.mp4" {
		t.Errorf("无名视频名 = %q,期望 transfer_2_6.mp4", got)
	}
}

// TestMessageInfoPicksGroupedID grouped_id 必须透传 —— 媒体组靠它归组,
// 与「具体哪条消息」的 SourceMsgID 是两回事。
func TestMessageInfoPicksGroupedID(t *testing.T) {
	const userID = int64(7428626313)

	msg := privatePhoto(101, userID)
	msg.SetGroupedID(999888)

	info, _ := messageInfoOf(msg, userID)
	if info.GroupedID != 999888 {
		t.Errorf("GroupedID = %d,期望 999888", info.GroupedID)
	}
	if info.SourceMsgID != int64(msg.GetID()) {
		t.Errorf("SourceMsgID = %d,期望 %d —— 它是消息自己的 id,不是 grouped_id",
			info.SourceMsgID, msg.GetID())
	}
}

// TestExtractMessagesAcceptsEveryContainerWithContent getMessages 有两个
// 带内容的容器,只认一个的话另一种会被当成「取回 0 条」。
func TestExtractMessagesAcceptsEveryContainerWithContent(t *testing.T) {
	want := []tg.MessageClass{privatePhoto(1, 555), privatePhoto(2, 555)}

	for _, tc := range []struct {
		name string
		box  tg.MessagesMessagesClass
	}{
		{"普通会话", &tg.MessagesMessages{Messages: want}},
		{"频道/超级群", &tg.MessagesChannelMessages{Messages: want}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, known := extractMessages(tc.box)
			if !known {
				t.Fatal("容器被当成不认识的 —— 相册会被误判成「用户撤回了」")
			}
			if len(got) != len(want) {
				t.Errorf("取回 %d 条,期望 %d", len(got), len(want))
			}
		})
	}
}

// TestExtractMessagesFlagsUnknownContainer 没见过的容器必须报「不认识」,
// 而不是安静地返回空 —— 后者会被调用方当成「用户撤回了消息」。
func TestExtractMessagesFlagsUnknownContainer(t *testing.T) {
	if _, known := extractMessages(&tg.MessagesMessagesSlice{Messages: []tg.MessageClass{
		privatePhoto(1, 555),
	}}); known {
		t.Error("不认识的容器必须返回 known=false,好让调用方报错而不是丢弃相册")
	}
}
