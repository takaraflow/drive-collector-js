package app

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/gotd/td/tg"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

type linkMockFetcher struct {
	mu           sync.Mutex
	lastUsername string
	lastChannel  int64
	lastIDs      []int64
	results      []tgclient.MessageInfo
	err          error
}

func (m *linkMockFetcher) FetchMessages(_ context.Context, _ int64, _ []int64) ([]tgclient.MessageInfo, error) {
	return nil, nil
}

func (m *linkMockFetcher) FetchChannelMessages(_ context.Context, username string, channelID int64, ids []int64) ([]tgclient.MessageInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastUsername = username
	m.lastChannel = channelID
	m.lastIDs = append([]int64(nil), ids...)
	if m.err != nil {
		return nil, m.err
	}
	return m.results, nil
}

type linkMockNotices struct {
	mu       sync.Mutex
	messages []string
	notices  []string
	edits    []string
	buttons  [][][]tgclient.Button
	nextID   int
}

func (n *linkMockNotices) SendMessage(_ context.Context, _ int64, text string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.messages = append(n.messages, text)
	return nil
}

func (n *linkMockNotices) SendWithButtonsAndID(_ context.Context, _ int64, text string, buttons [][]tgclient.Button) (int, error) {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.nextID++
	n.notices = append(n.notices, text)
	n.buttons = append(n.buttons, buttons)
	return n.nextID, nil
}

func (n *linkMockNotices) EditMessage(_ context.Context, _ int64, _ int, text string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.edits = append(n.edits, text)
	return nil
}

func (n *linkMockNotices) EditWithButtons(_ context.Context, _ int64, _ int, _ string, _ [][]tgclient.Button) error {
	return nil
}

func newTestLinkApp(repo *fakeRepo, drives DriveRepo, fetcher MessageFetcher, notices *linkMockNotices) *App {
	return &App{
		log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		repo:     repo,
		drives:   drives,
		notifier: notices,
		notices:  notices,
		fetcher:  fetcher,
		pending:  make(chan string, pendingQueueSize),
	}
}

func TestHandleLinkMessage_NotLink(t *testing.T) {
	repo := &fakeRepo{}
	notices := &linkMockNotices{}
	app := newTestLinkApp(repo, boundDrive(), nil, notices)

	msg := messageInfo{
		ChatID:   12345,
		SenderID: 67890,
		Text:     "hello world no link here",
		HasMedia: false,
	}

	consumed := app.handleLinkMessage(context.Background(), msg)
	if consumed {
		t.Fatalf("非链接文本不应被 handleLinkMessage 消费")
	}
	if len(notices.messages) != 0 || len(notices.notices) != 0 {
		t.Fatalf("不应发送任何通知")
	}
	if len(repo.created) != 0 {
		t.Fatalf("不应创建任务")
	}
}

func TestHandleLinkMessage_UnboundDrive(t *testing.T) {
	repo := &fakeRepo{}
	notices := &linkMockNotices{}
	app := newTestLinkApp(repo, &fakeDrives{}, nil, notices)

	msg := messageInfo{
		ChatID:   12345,
		SenderID: 67890,
		Text:     "https://t.me/mychannel/100",
		HasMedia: false,
	}

	consumed := app.handleLinkMessage(context.Background(), msg)
	if !consumed {
		t.Fatalf("链接应被消费")
	}
	if len(notices.messages) != 1 || !strings.Contains(notices.messages[0], "还没有绑定网盘") {
		t.Fatalf("期望未绑定网盘提示，收到: %v", notices.messages)
	}
	if len(repo.created) != 0 {
		t.Fatalf("未绑定网盘不应创建任务")
	}
}

func TestHandleLinkMessage_FetchError(t *testing.T) {
	repo := &fakeRepo{}
	notices := &linkMockNotices{}
	fetcher := &linkMockFetcher{err: errors.New("rpc network error")}
	app := newTestLinkApp(repo, boundDrive(), fetcher, notices)

	msg := messageInfo{
		ChatID:   12345,
		SenderID: 67890,
		Text:     "https://t.me/mychannel/100",
		HasMedia: false,
	}

	consumed := app.handleLinkMessage(context.Background(), msg)
	if !consumed {
		t.Fatalf("链接应被消费")
	}
	if len(notices.messages) != 1 || !strings.Contains(notices.messages[0], "无法解析这个链接") {
		t.Fatalf("期望无法解析通知，收到: %v", notices.messages)
	}
	if len(repo.created) != 0 {
		t.Fatalf("失败时不应创建任务")
	}
}

func TestHandleLinkMessage_TargetNotFoundOrNoMedia(t *testing.T) {
	repo := &fakeRepo{}
	notices := &linkMockNotices{}
	fetcher := &linkMockFetcher{
		results: []tgclient.MessageInfo{
			{ID: 100, HasMedia: false}, // 消息存在但无媒体
		},
	}
	app := newTestLinkApp(repo, boundDrive(), fetcher, notices)

	msg := messageInfo{
		ChatID:   12345,
		SenderID: 67890,
		Text:     "https://t.me/mychannel/100",
		HasMedia: false,
	}

	consumed := app.handleLinkMessage(context.Background(), msg)
	if !consumed {
		t.Fatalf("链接应被消费")
	}
	if len(notices.messages) != 1 || !strings.Contains(notices.messages[0], "无法解析这个链接") {
		t.Fatalf("无媒体消息应报错，收到: %v", notices.messages)
	}
	if len(repo.created) != 0 {
		t.Fatalf("不应创建任务")
	}
}

func TestHandleLinkMessage_SingleMedia(t *testing.T) {
	repo := &fakeRepo{}
	notices := &linkMockNotices{}
	fetcher := &linkMockFetcher{
		results: []tgclient.MessageInfo{
			{
				ID:         100,
				ChatID:     -1001999999999,
				HasMedia:   true,
				FileName:   "manual.pdf",
				FileSize:   1024,
				AccessHash: 55667788,
				GroupedID:  0,
			},
		},
	}
	app := newTestLinkApp(repo, boundDrive(), fetcher, notices)

	msg := messageInfo{
		ChatID:   12345,
		SenderID: 67890,
		Text:     "https://t.me/mychannel/100",
		HasMedia: false,
	}

	consumed := app.handleLinkMessage(context.Background(), msg)
	if !consumed {
		t.Fatalf("链接应被消费")
	}
	if len(repo.created) != 1 {
		t.Fatalf("应创建 1 个任务，实建: %d", len(repo.created))
	}

	task := repo.created[0]
	if task.UserID != "67890" {
		t.Errorf("task.UserID = %s, 期望 67890", task.UserID)
	}
	if !task.FileName.Valid || task.FileName.String != "manual.pdf" {
		t.Errorf("task.FileName = %v, 期望 manual.pdf", task.FileName)
	}
	if task.FileSize != 1024 {
		t.Errorf("task.FileSize = %d, 期望 1024", task.FileSize)
	}
	if !task.SourceMsgID.Valid || task.SourceMsgID.Int64 != 100 {
		t.Errorf("task.SourceMsgID = %v, 期望 100", task.SourceMsgID)
	}

	// 验证 SourceRef 带 hash
	cid, mid, hash, err := ParseSourceRefFull(task.SourceRef.String)
	if err != nil {
		t.Fatalf("ParseSourceRefFull 失败: %v", err)
	}
	if cid != -1001999999999 || mid != 100 || hash != 55667788 {
		t.Errorf("SourceRef 解析出 (%d, %d, %d), 期望 (-1001999999999, 100, 55667788)", cid, mid, hash)
	}

	// 确认入队
	select {
	case qid := <-app.pending:
		if qid != task.ID {
			t.Errorf("入队 taskId = %s, 期望 %s", qid, task.ID)
		}
	default:
		t.Fatalf("任务未入队")
	}

	// 确认发了任务确认卡片带取消按钮
	if len(notices.notices) != 1 || !strings.Contains(notices.notices[0], "已捕获文件任务") {
		t.Errorf("应发任务通知卡片，收到: %v", notices.notices)
	}
	if len(notices.buttons) != 1 || len(notices.buttons[0]) == 0 || !strings.HasPrefix(notices.buttons[0][0][0].Data, "cancel_confirm_") {
		t.Errorf("应包含取消按钮，收到: %v", notices.buttons)
	}
}

func TestHandleLinkMessage_SingleMedia_CreateDBError(t *testing.T) {
	repo := &fakeRepo{createErr: errors.New("db error")}
	notices := &linkMockNotices{}
	fetcher := &linkMockFetcher{
		results: []tgclient.MessageInfo{
			{
				ID:         100,
				ChatID:     -1001999999999,
				HasMedia:   true,
				FileName:   "manual.pdf",
				FileSize:   1024,
				AccessHash: 55667788,
			},
		},
	}
	app := newTestLinkApp(repo, boundDrive(), fetcher, notices)

	msg := messageInfo{
		ChatID:   12345,
		SenderID: 67890,
		Text:     "https://t.me/mychannel/100",
		HasMedia: false,
	}

	consumed := app.handleLinkMessage(context.Background(), msg)
	if !consumed {
		t.Fatalf("链接应被消费")
	}

	// 确认发送后修改为创建失败
	if len(notices.edits) != 1 || !strings.Contains(notices.edits[0], "创建任务失败") {
		t.Errorf("创建任务失败时应修改卡片，实收: %v", notices.edits)
	}
}

func TestHandleLinkMessage_AlbumMedia(t *testing.T) {
	repo := &fakeRepo{}
	notices := &linkMockNotices{}

	var msgs []tgclient.MessageInfo
	for i := 102; i >= 98; i-- { // 故意倒序给出，测试排序能力
		msgs = append(msgs, tgclient.MessageInfo{
			ID:         i,
			ChatID:     -1001234567890,
			HasMedia:   true,
			FileName:   fmt.Sprintf("photo_%d.jpg", i),
			FileSize:   2048,
			AccessHash: 998877,
			GroupedID:  777888999,
		})
	}
	// 混入一条无媒体消息和一条不同组媒体消息
	msgs = append(msgs, tgclient.MessageInfo{ID: 103, HasMedia: false, GroupedID: 777888999})
	msgs = append(msgs, tgclient.MessageInfo{ID: 104, HasMedia: true, GroupedID: 111222})

	fetcher := &linkMockFetcher{results: msgs}
	app := newTestLinkApp(repo, boundDrive(), fetcher, notices)

	msg := messageInfo{
		ChatID:   12345,
		SenderID: 67890,
		Text:     "https://t.me/mychannel/100",
		HasMedia: false,
	}

	consumed := app.handleLinkMessage(context.Background(), msg)
	if !consumed {
		t.Fatalf("链接应被消费")
	}
	if len(repo.batch) != 5 {
		t.Fatalf("同相册 5 条媒体应全部批量创建，实建: %d", len(repo.batch))
	}

	// 验证按消息 ID 升序排序
	for i, task := range repo.batch {
		expectedID := int64(98 + i)
		if task.SourceMsgID.Int64 != expectedID {
			t.Errorf("task[%d].SourceMsgID = %d, 期望升序 %d", i, task.SourceMsgID.Int64, expectedID)
		}
		if !task.GroupedID.Valid || task.GroupedID.Int64 != 777888999 {
			t.Errorf("GroupedID = %v, 期望 777888999", task.GroupedID)
		}
	}

	// 确认发了相册看板通知 (整组共享 1 条聚合看板卡片)
	if len(notices.notices) != 1 {
		t.Fatalf("相册总览聚合看板共需 1 条，实际: %d", len(notices.notices))
	}
	if !strings.Contains(notices.notices[0], "媒体组") || !strings.Contains(notices.notices[0], "5") {
		t.Errorf("第 1 条应为相册总览看板，收到: %v", notices.notices[0])
	}
	if len(notices.buttons) == 0 || !strings.HasPrefix(notices.buttons[0][0][0].Data, "cancel_group_confirm_777888999") {
		t.Errorf("相册通知应带取消整组按钮，收到: %v", notices.buttons)
	}

	// 确认回填了 5 个任务共享卡片 ID
	if len(repo.msgIDs) != 5 {
		t.Errorf("应回填 5 个任务共享看板 msg_id，实填: %d", len(repo.msgIDs))
	}

	// 确认 5 个任务均入队
	if len(app.pending) != 5 {
		t.Errorf("队中任务数 = %d, 期望 5", len(app.pending))
	}
}

func TestHandleLinkMessage_AlbumMedia_BatchDBError(t *testing.T) {
	repo := &fakeRepo{batchErr: errors.New("batch create failed")}
	notices := &linkMockNotices{}

	msgs := []tgclient.MessageInfo{
		{ID: 100, ChatID: -100123, HasMedia: true, GroupedID: 12345},
		{ID: 101, ChatID: -100123, HasMedia: true, GroupedID: 12345},
	}
	fetcher := &linkMockFetcher{results: msgs}
	app := newTestLinkApp(repo, boundDrive(), fetcher, notices)

	msg := messageInfo{
		ChatID:   12345,
		SenderID: 67890,
		Text:     "https://t.me/mychannel/100",
		HasMedia: false,
	}

	consumed := app.handleLinkMessage(context.Background(), msg)
	if !consumed {
		t.Fatalf("链接应被消费")
	}

	// 确认发送了媒体组创建任务失败提示
	if len(notices.messages) != 1 || !strings.Contains(notices.messages[0], "媒体组创建任务失败") {
		t.Errorf("期望发送媒体组创建失败通知，实收: %v", notices.messages)
	}
}

func TestHandleLinkMessage_MediaLimit10(t *testing.T) {
	repo := &fakeRepo{}
	notices := &linkMockNotices{}

	var msgs []tgclient.MessageInfo
	for i := 1; i <= 15; i++ {
		msgs = append(msgs, tgclient.MessageInfo{
			ID:         i,
			ChatID:     -1001234567890,
			HasMedia:   true,
			FileName:   fmt.Sprintf("img_%d.jpg", i),
			FileSize:   100,
			AccessHash: 111,
			GroupedID:  888,
		})
	}

	fetcher := &linkMockFetcher{results: msgs}
	app := newTestLinkApp(repo, boundDrive(), fetcher, notices)

	msg := messageInfo{
		ChatID:   12345,
		SenderID: 67890,
		Text:     "https://t.me/mychannel/5",
		HasMedia: false,
	}

	consumed := app.handleLinkMessage(context.Background(), msg)
	if !consumed {
		t.Fatalf("链接应被消费")
	}

	// 确认发了上限 10 的警告
	hasLimitNotice := false
	for _, m := range notices.messages {
		if strings.Contains(m, "仅处理前 10 个媒体") {
			hasLimitNotice = true
			break
		}
	}
	if !hasLimitNotice {
		t.Fatalf("应发送超过 10 个媒体警告，收到: %v", notices.messages)
	}

	if len(repo.batch) != 10 {
		t.Fatalf("创建的任务数应被截断为 10，实建: %d", len(repo.batch))
	}
	if len(app.pending) != 10 {
		t.Fatalf("入队数量应为 10，实际: %d", len(app.pending))
	}
}

func TestHandleLinkMessage_PrivateChannelLink(t *testing.T) {
	repo := &fakeRepo{}
	notices := &linkMockNotices{}
	fetcher := &linkMockFetcher{
		results: []tgclient.MessageInfo{
			{
				ID:         456,
				ChatID:     -1001234567890,
				HasMedia:   true,
				FileName:   "secret.zip",
				FileSize:   5000,
				AccessHash: 12345,
			},
		},
	}
	app := newTestLinkApp(repo, boundDrive(), fetcher, notices)

	msg := messageInfo{
		ChatID:   12345,
		SenderID: 67890,
		Text:     "https://t.me/c/1234567890/456",
		HasMedia: false,
	}

	consumed := app.handleLinkMessage(context.Background(), msg)
	if !consumed {
		t.Fatalf("链接应被消费")
	}

	// 验证 fetcher 收到的参数
	fetcher.mu.Lock()
	defer fetcher.mu.Unlock()
	if fetcher.lastUsername != "" {
		t.Errorf("私有频道 username 应为空，实际: %s", fetcher.lastUsername)
	}
	if fetcher.lastChannel != 1234567890 {
		t.Errorf("私有频道 ID 期望 1234567890，实际: %d", fetcher.lastChannel)
	}
	// 验证探测范围是以 456 为中心
	if len(fetcher.lastIDs) == 0 || fetcher.lastIDs[0] != 447 || fetcher.lastIDs[len(fetcher.lastIDs)-1] != 465 {
		t.Errorf("探测范围期望 [447 .. 465]，实际: %v", fetcher.lastIDs)
	}

	if len(repo.created) != 1 {
		t.Fatalf("应创建 1 个任务")
	}
}

func TestHandleLinkMessage_ForumTopicLink(t *testing.T) {
	repo := &fakeRepo{}
	notices := &linkMockNotices{}
	fetcher := &linkMockFetcher{
		results: []tgclient.MessageInfo{
			{
				ID:         999,
				ChatID:     -1001234567890,
				HasMedia:   true,
				FileName:   "topic_doc.pdf",
				FileSize:   2000,
				AccessHash: 54321,
			},
		},
	}
	app := newTestLinkApp(repo, boundDrive(), fetcher, notices)

	// 带 topic ID 10 的私有群链接
	msg := messageInfo{
		ChatID:   12345,
		SenderID: 67890,
		Text:     "https://t.me/c/1234567890/10/999",
		HasMedia: false,
	}

	consumed := app.handleLinkMessage(context.Background(), msg)
	if !consumed {
		t.Fatalf("链接应被消费")
	}

	fetcher.mu.Lock()
	defer fetcher.mu.Unlock()
	// 探测范围应以 999 为中心，而不是以 10 为中心
	if len(fetcher.lastIDs) == 0 || fetcher.lastIDs[0] != 990 || fetcher.lastIDs[len(fetcher.lastIDs)-1] != 1008 {
		t.Errorf("探测范围期望 [990 .. 1008]，实际: %v", fetcher.lastIDs)
	}

	if len(repo.created) != 1 {
		t.Fatalf("应创建 1 个任务")
	}
}

func TestOnUpdate_LinkMessage(t *testing.T) {
	repo := &fakeRepo{}
	notices := &linkMockNotices{}
	fetcher := &linkMockFetcher{
		results: []tgclient.MessageInfo{
			{
				ID:         88,
				ChatID:     -1001234567890,
				HasMedia:   true,
				FileName:   "song.mp3",
				FileSize:   1024,
				AccessHash: 98765,
			},
		},
	}
	app := newTestLinkApp(repo, boundDrive(), fetcher, notices)

	msg := &tg.Message{
		ID:      1,
		Message: "Check this out https://t.me/channel_music/88 listen to it!",
		PeerID:  &tg.PeerUser{UserID: 777},
		FromID:  &tg.PeerUser{UserID: 777},
	}

	u := tgclient.Update{
		Kind: tgclient.KindNewMessage,
		Raw:  &tg.UpdateNewMessage{Message: msg},
	}

	if err := app.onUpdate(context.Background(), u); err != nil {
		t.Fatalf("onUpdate 失败: %v", err)
	}

	if len(repo.created) != 1 {
		t.Fatalf("onUpdate 应创建 1 个链接转存任务，实际: %d", len(repo.created))
	}
	if repo.created[0].FileName.String != "song.mp3" {
		t.Errorf("task.FileName = %s, 期望 song.mp3", repo.created[0].FileName.String)
	}
}
