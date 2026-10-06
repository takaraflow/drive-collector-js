package app

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gotd/td/tg"
	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	task "github.com/youngsx/drive-collector/cmd/collector/internal/task"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// mediaUpdate 造一条带文件的消息 update。
func mediaUpdate(msgID, senderID int64) tgclient.Update {
	doc := &tg.Document{ID: 7, Size: 2048}
	doc.Attributes = []tg.DocumentAttributeClass{
		&tg.DocumentAttributeFilename{FileName: "video.mp4"},
	}
	msg := &tg.Message{
		ID:     int(msgID),
		PeerID: &tg.PeerChat{ChatID: 999},
	}
	// 用 SetXxx helper,不要裸设 flag 位 —— flag 编号是借位对齐的
	// (media 是 9,from_id 是 8),写错数字会因为「碰巧通过」而骗人。
	msg.SetFromID(&tg.PeerUser{UserID: senderID})
	msg.SetMedia(&tg.MessageMediaDocument{Document: doc})

	return tgclient.Update{
		Kind: tgclient.KindNewMessage,
		Raw:  &tg.UpdateNewMessage{Message: msg},
	}
}

// TestCreateTaskEnqueuesForProcessing 是这次生产故障的回归测试。
//
// 生产实测:用户发了 video.mp4,任务建出来了、日志一切正常,但状态
// 永远停在 queued —— worker 模式下没有 QStash 回调会来推它,而建任务
// 时也没人把它排进队列。整条转存链路静默断在第一环。
//
// 断言看着弱(「队列里多了一个 id」),但这是唯一能拦住「任务建了却
// 没人处理」的地方 —— 而那个故障在日志里完全看不见。
func TestCreateTaskEnqueuesForProcessing(t *testing.T) {
	repo := &fakeRepo{}
	// 给一个盘 —— 没盘时门禁会拦下任务(见
	// TestCreateTaskRefusesWithoutDrive),那测的就不是排队这件事了。
	a, _ := newTestApp(t, &fakeDL{content: "x"}, repo, boundDrive())
	// createTaskFrom 要读 tg.SelfID() 判断「是不是自己发的」。
	// 真实客户端只在连上之后才有值,这里用一个不上网的实例 ——
	// SelfID 会是 0,于是「自己发的」判断被跳过,正是我们要的路径。
	a.tg = newOfflineTG(t)

	ctx := context.Background()
	if err := a.createTaskFrom(ctx, mediaUpdate(42, 555)); err != nil {
		t.Fatal(err)
	}
	if len(repo.created) != 1 {
		t.Fatalf("应建 1 个任务,实际 %d", len(repo.created))
	}
	want := repo.created[0].ID

	select {
	case got := <-a.pending:
		if got != want {
			t.Errorf("队列里的 id = %q,期望 %q", got, want)
		}
	case <-time.After(time.Second):
		t.Fatal("任务建了但没排队 —— 它会永远停在 queued(生产故障原样复现)")
	}
}

// newOfflineTG 造一个不联网的 Telegram 客户端。
//
// 只用于需要 tg.SelfID() 的路径 —— 它不建立连接,任何真实 API 调用
// 都会失败。别拿它测下载。
func newOfflineTG(t *testing.T) *tgclient.Client {
	t.Helper()
	c, err := tgclient.New(tgclient.Config{
		APIID:   1,
		APIHash: "0",
		Session: loadSession(t),
		Handler: func(context.Context, tgclient.Update) error { return nil },
		Log:     quietApp(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// wireManagerForTest 按 New 的方式接好 Manager,供 processTask 测试用。
//
// 刻意不抽成 New 的共享函数:New 里的接线顺序和依赖是生产契约的一部分,
// 测试自己再接一遍,则「New 忘了接线」会被这里的失败暴露出来。
func (a *App) wireManagerForTest() {
	m := task.NewManager(a.repo, a.log)
	m.Download = a.download
	m.Upload = a.upload
	a.tasks = m
}

// TestProcessTaskRunsDownloadThenUpload 守住「建完真的会去下载和上传」。
//
// 只断言队列里有 id 不够 —— 万一消费循环没人调用,任务照样卡死。
func TestProcessTaskRunsDownloadThenUpload(t *testing.T) {
	content := "1234567890"
	dl := &fakeDL{content: content}
	repo := &fakeRepo{byID: &store.Task{}}
	drives := &fakeDrives{drive: &drive.Drive{Type: "protondrive"}}
	a, dir := newTestApp(t, dl, repo, drives)

	// 按 New 的接法装配 Manager —— 这里漏一根线,测试就红。
	a.wireManagerForTest()

	// fakeRepo.FindById 返回要处理的那条任务。
	row := store.Task{
		ID:        "t1",
		UserID:    "555",
		FileName:  sqlStr("photo.jpg"),
		SourceRef: sqlStr("555/42"),
	}
	repo.byID = &row

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	a.processTask(ctx, "t1")

	if dl.calls != 1 {
		t.Errorf("下载调用 %d 次,期望 1", dl.calls)
	}
	// 上传成功后本地文件【应该】已被删掉。
	//
	// 这条断言以前反过来(要求文件留着)。留着的东西没人用,却会把容器
	// 1GB 盘撑满,而盘满的表现是【所有】任务一起失败,排查时却会往
	// 网盘方向找 —— 失败/取消路径残留更甚,所以现在无条件删。
	if _, err := os.Stat(filepath.Join(dir, "photo.jpg")); err == nil {
		t.Errorf("上传成功后本地文件仍留在 %s —— 会把容器磁盘撑爆", dir)
	}

	var sawDownload, sawUpload bool
	for _, ev := range repo.events() {
		switch ev {
		case contract.EventStartDownload:
			sawDownload = true
		case contract.EventStartUpload:
			sawUpload = true
		}
	}
	if !sawDownload || !sawUpload {
		t.Errorf("状态推进不完整:download=%v upload=%v (events=%v)",
			sawDownload, sawUpload, repo.events())
	}
}

// TestRecoverRequeuesStalledTasks 重启后卡住的任务必须被重新排队。
//
// 两种卡法都要覆盖:
//   - queued:建了但没人处理(这次生产故障留下的那批)。状态本来就对,
//     不该再发 reset_stalled —— 状态机只允许从 downloading/downloaded/
//     uploading 重置,对 queued 发会被拒。
//   - downloading:进程死在下载中途。必须先重置再排队。
func TestRecoverRequeuesStalledTasks(t *testing.T) {
	repo := &fakeRepo{stalled: []store.Task{
		{ID: "stuck-queued", Status: contract.StatusQueued},
		{ID: "stuck-downloading", Status: contract.StatusDownloading},
	}}
	a, _ := newTestApp(t, &fakeDL{}, repo, &fakeDrives{})

	a.recoverOnStart(context.Background())

	got := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case id := <-a.pending:
			got[id] = true
		case <-time.After(time.Second):
			t.Fatalf("只排了 %d 个,期望 2 个(卡住的任务必须全部重新排队)", len(got))
		}
	}
	if !got["stuck-queued"] || !got["stuck-downloading"] {
		t.Errorf("排队结果 = %v,两个都该在", got)
	}

	// queued 那条不该被重置 —— 状态机不允许。
	for _, ev := range repo.eventsByID("stuck-queued") {
		if ev == contract.EventResetStalled {
			t.Errorf("对 queued 任务发了 reset_stalled —— 状态机会拒绝,任务反而卡死")
		}
	}
	// downloading 那条必须被重置,否则它会带着 downloading 状态重新入队,
	// 而 start_download 只接受 queued —— 同样卡死。
	var sawReset bool
	for _, ev := range repo.eventsByID("stuck-downloading") {
		if ev == contract.EventResetStalled {
			sawReset = true
		}
	}
	if !sawReset {
		t.Error("downloading 的僵尸任务没被重置 —— 它会带着错状态重新入队")
	}
}

// TestQueueBlocksRatherThanDrops 队列满时必须阻塞,不能丢任务。
//
// 丢任务 = 用户的文件永远不转存且没有提示;阻塞 = 慢一点但会做完。
//
// ponytail: 阻塞会让入队方在队列满时卡住 —— 单实例下入队方是 Telegram
// 回调,卡住表现为「响应变慢」。多实例时入队方是 webhook,那时该换成
// Redis 队列而不是加长内存队列。
func TestQueueBlocksRatherThanDrops(t *testing.T) {
	a, _ := newTestApp(t, &fakeDL{}, &fakeRepo{}, &fakeDrives{})

	for i := 0; i < pendingQueueSize; i++ {
		a.enqueue(context.Background(), "task")
	}

	done := make(chan struct{})
	go func() {
		a.enqueue(context.Background(), "overflow")
		close(done)
	}()

	select {
	case <-done:
		t.Fatal("队列满时不该直接返回 —— 那会把任务丢掉")
	case <-time.After(100 * time.Millisecond):
		// 正确:阻塞等待。
	}
}

// TestEnqueueUnblocksOnShutdown 进程关闭时不能死等。
//
// 否则 SIGTERM 之后容器卡在 enqueue 上不退出,编排器只能强杀 ——
// 强杀会留下孤儿 staging 文件(记忆里 «网盘被撑爆» 那次)。
func TestEnqueueUnblocksOnShutdown(t *testing.T) {
	a, _ := newTestApp(t, &fakeDL{}, &fakeRepo{}, &fakeDrives{})

	for i := 0; i < pendingQueueSize; i++ {
		a.enqueue(context.Background(), "task")
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		a.enqueue(ctx, "overflow")
		close(done)
	}()

	select {
	case <-done:
		// 正确:ctx 取消后立刻放行,任务留给下次启动恢复。
	case <-time.After(time.Second):
		t.Fatal("关闭时 enqueue 死等 —— 容器只能被强杀")
	}
}
