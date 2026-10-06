package app

import (
	"context"
	"fmt"
	"io"
	"log/slog"

	"testing"

	"github.com/youngsx/drive-collector/cmd/collector/internal/task"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// fakeFetcher 回放一批消息 —— 相册刷盘时回源用的假实现。
type fakeFetcher struct {
	msgs []tgclient.MessageInfo
	err  error
	// asked 记下回源时用了哪些 id:缓冲里只存 id,内容现取,
	// 所以这一条链路本身就是被测对象。
	asked []int64
}

func (f *fakeFetcher) FetchMessages(_ context.Context, _ int64, ids []int64) ([]tgclient.MessageInfo, error) {
	f.asked = append(f.asked, ids...)
	if f.err != nil {
		return nil, f.err
	}
	return f.msgs, nil
}

// newAlbumApp 造一个只够测 flushMediaGroup 的 App。
func newAlbumApp(repo *fakeRepo, f *fakeFetcher, nf *fakeNotices) *App {
	return &App{
		log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		repo:     repo,
		drives:   boundDrive(),
		notifier: nf,
		notices:  nf,
		fetcher:  f,
		pending:  make(chan string, pendingQueueSize),
	}
}

// albumMsgs 造 n 张「照片」消息。
func albumMsgs(chatID, userID int64, n int) []tgclient.MessageInfo {
	out := make([]tgclient.MessageInfo, 0, n)
	for i := 1; i <= n; i++ {
		out = append(out, tgclient.MessageInfo{
			ID:        100 + i,
			ChatID:    chatID,
			SenderID:  userID,
			GroupedID: 999888,
			HasMedia:  true,
			FileName:  fmt.Sprintf("transfer_4_%d.jpg", 500+i),
		})
	}
	return out
}

const albumUser = int64(7428626313)

// TestFlushMediaGroupCreatesTasksForEveryPhoto 相册存在的全部意义:
// 一批照片要变成同样多条任务。
//
// 这条链路此前在 app 层零覆盖,而它坏掉的形态是「用户发 10 张图,
// 什么都没发生」—— 测试全绿也拦不住。
func TestFlushMediaGroupCreatesTasksForEveryPhoto(t *testing.T) {
	const n = 10 // 用户常发的相册大小

	repo := &fakeRepo{}
	f := &fakeFetcher{msgs: albumMsgs(albumUser, albumUser, n)}
	nf := &fakeNotices{}
	a := newAlbumApp(repo, f, nf)

	err := a.flushMediaGroup(context.Background(), "999888",
		task.GroupMeta{GID: "999888", ChatID: albumUser, UserID: albumUser},
		[]int64{101, 102, 103, 104, 105, 106, 107, 108, 109, 110})
	if err != nil {
		t.Fatalf("刷盘失败: %v", err)
	}

	if len(repo.batch) != n {
		t.Fatalf("建了 %d 条任务,期望 %d —— 用户的相册少了 %d 张",
			len(repo.batch), n, n-len(repo.batch))
	}

	// 每条任务都必须带真实 user_id:上传阶段要靠它查网盘,
	// 写成 0 会得到「用户 0 没有绑定网盘」—— 任务建得出来、下载跑得动,
	// 只在最后一刻炸。
	for i, tsk := range repo.batch {
		if tsk.UserID != fmt.Sprint(albumUser) {
			t.Errorf("第 %d 条 user_id = %q,期望 %d", i, tsk.UserID, albumUser)
		}
	}

	// 文件名不能全塌成同一个:那会让 10 张图在网盘上互相覆盖,
	// 用户只剩 1 张,且全程不报错。
	seen := map[string]bool{}
	for i, tsk := range repo.batch {
		name := tsk.FileName.String
		if name == "" || name == "unnamed" {
			t.Fatalf("第 %d 条没有文件名(%q)—— 相册会塌成一个文件", i, name)
		}
		if seen[name] {
			t.Errorf("第 %d 条的文件名与前面重复:%q", i, name)
		}
		seen[name] = true
	}

	// 回源时用的 id 必须与缓冲里存的一致。
	if len(f.asked) != n {
		t.Errorf("回源取了 %d 个 id,期望 %d", len(f.asked), n)
	}

	// 用户必须收到回音,否则就是「已读不回」。
	if len(nf.sent) != n {
		t.Errorf("发了 %d 条状态消息,期望 %d —— 用户看不到任何回音", len(nf.sent), n)
	}
}

// TestFlushMediaGroupNoticesOnlyAfterTasksExist 状态消息不能在任务
// 建出来之前发。
//
// 反了的话,建任务失败时用户已经收到 N 条「已捕获」,而每条的取消按钮
// 都指向一个不存在的任务,消息也永远停在「已捕获」不动。
func TestFlushMediaGroupNoticesOnlyAfterTasksExist(t *testing.T) {
	repo := &fakeRepo{batchErr: fmt.Errorf("建任务失败")}
	f := &fakeFetcher{msgs: albumMsgs(albumUser, albumUser, 3)}
	nf := &fakeNotices{}
	a := newAlbumApp(repo, f, nf)

	err := a.flushMediaGroup(context.Background(), "g",
		task.GroupMeta{GID: "g", ChatID: albumUser, UserID: albumUser},
		[]int64{101, 102, 103})
	if err == nil {
		t.Fatal("建任务失败时必须返回错误,好让组留在 Redis 里")
	}
	if len(nf.sent) != 0 {
		t.Errorf("建任务失败却发了 %d 条状态消息:%q —— 取消按钮指向不存在的任务",
			len(nf.sent), nf.sent)
	}
}

// TestFlushMediaGroupBackfillsNoticeMsgID 状态消息发出去之后要把它的
// id 回填进任务 —— 后续每个阶段都靠它编辑同一条消息。
func TestFlushMediaGroupBackfillsNoticeMsgID(t *testing.T) {
	repo := &fakeRepo{}
	f := &fakeFetcher{msgs: albumMsgs(albumUser, albumUser, 2)}
	nf := &fakeNotices{}
	a := newAlbumApp(repo, f, nf)

	if err := a.flushMediaGroup(context.Background(), "g",
		task.GroupMeta{GID: "g", ChatID: albumUser, UserID: albumUser},
		[]int64{101, 102}); err != nil {
		t.Fatal(err)
	}

	// fakeNotices 恒返回 9001。
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if len(repo.msgIDs) != 2 {
		t.Fatalf("回填了 %d 个 msg_id,期望 2", len(repo.msgIDs))
	}
	for i, id := range repo.msgIDs {
		if id != 9001 {
			t.Errorf("第 %d 个 msg_id = %d,期望 9001", i, id)
		}
	}
}

// TestFlushMediaGroupEnqueuesTasks 建完必须排队,否则这批照片只会
// 躺在 queued 里 —— 与单条路径同一个道理。
func TestFlushMediaGroupEnqueuesTasks(t *testing.T) {
	repo := &fakeRepo{}
	f := &fakeFetcher{msgs: albumMsgs(albumUser, albumUser, 3)}
	a := newAlbumApp(repo, f, &fakeNotices{})

	if err := a.flushMediaGroup(context.Background(), "g",
		task.GroupMeta{GID: "g", ChatID: albumUser, UserID: albumUser},
		[]int64{101, 102, 103}); err != nil {
		t.Fatal(err)
	}
	if n := len(a.pending); n != 3 {
		t.Errorf("排队 %d 条,期望 3 —— 建完没人处理,照片永远停在 queued", n)
	}
}

// TestFlushMediaGroupKeepsGroupOnFetchFailure 回源失败时必须返回错误。
//
// 返回 nil 会让缓冲把组清掉 —— 那批照片就永久消失了,而且用户已经
// 什么都收不到。这是「静默丢数据」里最糟的一种。
func TestFlushMediaGroupKeepsGroupOnFetchFailure(t *testing.T) {
	repo := &fakeRepo{}
	f := &fakeFetcher{err: fmt.Errorf("网络抽风")}
	nf := &fakeNotices{}
	a := newAlbumApp(repo, f, nf)

	err := a.flushMediaGroup(context.Background(), "g",
		task.GroupMeta{GID: "g", ChatID: albumUser, UserID: albumUser},
		[]int64{101})
	if err == nil {
		t.Fatal("回源失败必须返回错误,否则组被清掉、照片永久丢失")
	}
	if len(repo.batch) != 0 {
		t.Errorf("回源失败却建了 %d 条任务", len(repo.batch))
	}
	if len(nf.sent) != 0 {
		t.Errorf("回源失败却给用户发了 %d 条消息", len(nf.sent))
	}
}
