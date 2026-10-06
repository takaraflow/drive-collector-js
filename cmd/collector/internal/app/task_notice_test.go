package app

// 任务状态消息的回归测试。
//
// 生产故障:用户发完文件只看到「已读」,没有任何回音。Go 侧建完任务
// 直接入队,一句话不发 —— 任务在后台跑完了用户也不知道成功还是失败。

import (
	"context"
	"strings"
	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// fakeNotices 记录任务状态消息的收发。
type fakeNotices struct {
	sent     []string
	edits    []string
	sendBtns [][][]tgclient.Button
	editBtns [][][]tgclient.Button
}

func (f *fakeNotices) SendMessage(_ context.Context, _ int64, text string) error {
	f.sent = append(f.sent, text)
	return nil
}

func (f *fakeNotices) SendWithButtonsAndID(_ context.Context, _ int64, text string, buttons [][]tgclient.Button) (int, error) {
	f.sent = append(f.sent, text)
	f.sendBtns = append(f.sendBtns, buttons)
	return 9001, nil
}

func (f *fakeNotices) EditMessage(_ context.Context, _ int64, _ int, text string) error {
	f.edits = append(f.edits, text)
	return nil
}

func (f *fakeNotices) EditWithButtons(_ context.Context, _ int64, _ int, text string, buttons [][]tgclient.Button) error {
	f.edits = append(f.edits, text)
	f.editBtns = append(f.editBtns, buttons)
	return nil
}

// noticeTask 造一条「已经建好、状态消息已发」的任务。
func noticeTask(status, errMsg string) store.Task {
	return store.Task{
		ID:        "task-1",
		UserID:    "555",
		ChatID:    nullableString("999"),
		SourceRef: nullableString(BuildSourceRef(999, 42)),
		MsgID:     nullableInt(9001),
		FileName:  nullableString("video.mp4"),
		Status:    contract.TaskStatus(status),
		ErrorMsg:  nullableString(errMsg),
	}
}

// TestCreateTaskRepliesImmediately 投递文件后必须立刻有回音。
//
// 断言三件事:发了一条带「取消排队」按钮的消息、它的 id 写进了
// msg_id(后续阶段靠它编辑这一条)、chat_id 与 source_msg_id 落库。
func TestCreateTaskRepliesImmediately(t *testing.T) {
	repo := &fakeRepo{}
	notices := &fakeNotices{}
	a, _ := newTestApp(t, &fakeDL{content: "x"}, repo, boundDrive())
	a.notices = notices
	a.tg = newOfflineTG(t)

	if err := a.createTaskFrom(context.Background(), mediaUpdate(42, 555)); err != nil {
		t.Fatal(err)
	}

	if len(notices.sent) != 1 || !strings.Contains(notices.sent[0], "已捕获") {
		t.Fatalf("投递文件后应该立刻回一条「已捕获」,实际发了 %v", notices.sent)
	}
	if len(notices.sendBtns) != 1 || len(notices.sendBtns[0]) == 0 {
		t.Fatal("状态消息要带取消按钮 —— 用户否则没有退出排队的手柄")
	}
	if got := notices.sendBtns[0][0][0].Data; !strings.HasPrefix(got, "cancel_confirm_") {
		t.Errorf("按钮 data = %q,期望 cancel_confirm_<taskId>", got)
	}

	if len(repo.created) != 1 {
		t.Fatalf("应建 1 个任务,实际 %d", len(repo.created))
	}
	created := repo.created[0]
	if !created.MsgID.Valid || created.MsgID.Int64 != 9001 {
		t.Errorf("msg_id = %v,期望 9001 —— 它必须是 bot 自己那条状态消息;"+
			"写成用户发来的消息 id 会让每次编辑都打到用户的文件消息上", created.MsgID)
	}
	if created.ChatID.String != "999" {
		t.Errorf("chat_id = %q,期望 999", created.ChatID.String)
	}
	if created.SourceMsgID.Int64 != 42 {
		t.Errorf("source_msg_id = %d,期望 42(用户发来的那条消息)", created.SourceMsgID.Int64)
	}
}

// TestNotifyOutcomeReportsFailure 上传失败必须告诉用户「为什么」。
//
// 只回一句「转存失败」的话,用户除了重发一遍没有别的动作可做。
func TestNotifyOutcomeReportsFailure(t *testing.T) {
	task := noticeTask("failed", "上传失败: rclone: 磁盘满了")
	notices := &fakeNotices{}
	a, _ := newTestApp(t, &fakeDL{content: "x"}, &fakeRepo{byID: &task}, boundDrive())
	a.notices = notices

	a.notifyOutcome(context.Background(), task.ID, true)

	got := strings.Join(notices.edits, "\n")
	if !strings.Contains(got, "转存失败") || !strings.Contains(got, "磁盘满了") {
		t.Fatalf("失败通知要带真实原因,实际:%q", got)
	}
	if len(notices.editBtns) == 0 || len(notices.editBtns[0][0]) == 0 {
		t.Fatal("上传失败要给「重试」按钮")
	}
	if got := notices.editBtns[0][0][0].Data; !strings.HasPrefix(got, "retry_confirm_") {
		t.Errorf("重试按钮 data = %q,期望 retry_confirm_<taskId>", got)
	}
}

// TestNotifyOutcomeSilentWhenBlocked 只是被状态机挡下不算失败。
//
// 用户已取消 / 已在处理中都会回 Success=false,但那是「这次没轮到你」,
// 不是「转存失败」—— 给用户弹失败是撒谎。
func TestNotifyOutcomeSilentWhenBlocked(t *testing.T) {
	task := noticeTask("downloading", "")
	notices := &fakeNotices{}
	a, _ := newTestApp(t, &fakeDL{content: "x"}, &fakeRepo{byID: &task}, boundDrive())
	a.notices = notices

	a.notifyOutcome(context.Background(), task.ID, true)

	if len(notices.edits) != 0 {
		t.Errorf("任务还在处理中就不该改它的状态消息,实际改了:%v", notices.edits)
	}
}

// TestNoticeFallsBackToNewMessage 没有 msg_id 时要补发一条。
//
// msg_id 为 0(建任务时发消息失败、或 Go 接管前建的老任务)是最容易被
// 悄悄跳过的分支 —— 结果是这条任务全程没有任何可见进展。
func TestNoticeFallsBackToNewMessage(t *testing.T) {
	notices := &fakeNotices{}
	a, _ := newTestApp(t, &fakeDL{content: "x"}, &fakeRepo{}, boundDrive())
	a.notices = notices

	task := noticeTask("queued", "")
	task.MsgID = nullableInt(0)
	a.notify(context.Background(), &task, noticeDownloading, nil)

	if len(notices.edits) != 0 || len(notices.sent) == 0 {
		t.Errorf("没有 msg_id 时应改为发一条新消息,实际 edits=%v sent=%v",
			notices.edits, notices.sent)
	}
}
