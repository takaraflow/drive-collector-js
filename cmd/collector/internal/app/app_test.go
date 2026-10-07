package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gotd/td/tg"

	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/task"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
	"github.com/youngsx/drive-collector/cmd/collector/internal/tgsession"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

func loadSession(t *testing.T) *tgsession.Session {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "..", "testdata", "tgsession_vectors.json"))
	if err != nil {
		t.Fatalf("读向量失败: %v", err)
	}
	var v struct {
		Cases []struct {
			S string `json:"s"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	s, err := tgsession.Parse(v.Cases[0].S)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// TestSanitizeBlocksTraversal 文件名来自 Telegram,是完全不受控的输入。
//
// 目录穿越不是洁癖:命中后下载会落到任意可写路径,
// 而那些文件随后会被当成用户上传的内容发到网盘。
func TestSanitizeBlocksTraversal(t *testing.T) {
	cases := []struct{ in, mustNotContain string }{
		{"../../etc/passwd", ".."},
		{"..", ".."},
		{".", ".."},
		{"", ""},
		{"a/b/c.txt", "/"},
		{`C:\Windows\System32\evil.dll`, "\\"},
		{"normal.txt", ".."}, // 正常的应原样通过
	}
	for _, tc := range cases {
		got := sanitize(tc.in)
		if tc.mustNotContain != "" && strings.Contains(got, tc.mustNotContain) {
			t.Errorf("sanitize(%q) = %q,不该包含 %q", tc.in, got, tc.mustNotContain)
		}
		if got == "" {
			t.Errorf("sanitize(%q) 返回空串 —— 后续路径拼接会把文件写成目录", tc.in)
		}
		if strings.HasPrefix(got, ".") {
			t.Errorf("sanitize(%q) = %q,不该以点开头(会变成隐藏文件)", tc.in, got)
		}
	}
}

// TestSanitizeStripsControlChars 控制字符和非 ASCII 必须被替换。
func TestSanitizeStripsControlChars(t *testing.T) {
	got := sanitize("bad\x00name\n换行.exe")
	if strings.ContainsAny(got, "\x00\n") {
		t.Errorf("sanitize 未清除控制字符: %q", got)
	}
	if !strings.Contains(got, "bad") || !strings.Contains(got, "exe") {
		t.Errorf("sanitize 应保留可读部分: %q", got)
	}
}

// TestSanitizeTruncates 超长文件名要截断 —— 路径长度有限度,
// 不截会得到 ENAMETOOLONG。
func TestSanitizeTruncates(t *testing.T) {
	long := strings.Repeat("a", 500) + ".txt"
	if got := sanitize(long); len(got) > 200 {
		t.Errorf("长度 = %d,应截断到 200 以内", len(got))
	}
}

// TestTaskIDIsUnpredictable 任务 id 会出现在文件名和日志里,
// 可猜测会泄漏「这个用户一共多少任务」。
func TestTaskIDIsUnpredictable(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 1000; i++ {
		id := newTaskID()
		if seen[id] {
			t.Fatalf("第 %d 次生成了重复 id: %s", i, id)
		}
		seen[id] = true
		if !strings.HasPrefix(id, "task-") {
			t.Errorf("id %q 缺前缀", id)
		}
	}
}

// TestFileNameOfDocument 文档名要从 attribute 里取。
func TestFileNameOfDocument(t *testing.T) {
	doc := &tg.Document{ID: 1, Size: 100}
	doc.Attributes = []tg.DocumentAttributeClass{
		&tg.DocumentAttributeFilename{FileName: "report.pdf"},
	}
	media := &tg.MessageMediaDocument{Document: doc}

	if got := fileNameOf(media); got != "report.pdf" {
		t.Errorf("文件名 = %q,期望 report.pdf", got)
	}
}

// TestFileNameOfDocumentWithoutName 没文件名属性时编一个稳定名 ——
// 空名会让整个相册塌成同一个 unnamed 文件。
func TestFileNameOfDocumentWithoutName(t *testing.T) {
	doc := &tg.Document{ID: 1, Size: 100}
	doc.Attributes = nil
	if got := fileNameOf(&tg.MessageMediaDocument{Document: doc}); got != "transfer_0_1.bin" {
		t.Errorf("无文件名属性时应编稳定名,得到 %q", got)
	}
}

// TestFromMessageExtractsMediaFields 从消息里抽字段。
func TestFromMessageExtractsMediaFields(t *testing.T) {
	doc := &tg.Document{ID: 7, Size: 2048}
	doc.Attributes = []tg.DocumentAttributeClass{
		&tg.DocumentAttributeFilename{FileName: "a.zip"},
	}
	// gotd 的 getter 靠 Flags 判断字段是否有效:直接给字段赋值不会设
	// flag,getter 一律返回零值。必须走 SetXxx helper。
	//
	// 这里刻意不用裸的 Flags.Set(数字):flag 编号在生成代码里是
	// 借位对齐的(media 是 9,from_id 是 8),写错一个数字测试就会
	// 因为「碰巧」通过而给出虚假的安心 —— 这个文件之前就这么错过。
	msg := &tg.Message{
		ID:     42,
		PeerID: &tg.PeerChat{ChatID: 999},
	}
	msg.SetFromID(&tg.PeerUser{UserID: 555})
	msg.SetMedia(&tg.MessageMediaDocument{Document: doc})

	info, ok := fromMessage(msg)
	if !ok {
		t.Fatal("应能提取")
	}
	if info.ID != 42 {
		t.Errorf("ID = %d", info.ID)
	}
	if info.ChatID != 999 {
		t.Errorf("ChatID = %d", info.ChatID)
	}
	if info.SenderID != 555 {
		t.Errorf("SenderID = %d", info.SenderID)
	}
	if !info.HasMedia {
		t.Error("HasMedia 应为 true")
	}
	if info.FileName != "a.zip" {
		t.Errorf("FileName = %q", info.FileName)
	}
}

// TestFromMessageRejectsEmpty 空消息不该被当成有效消息。
// TestFromMessageInfersSenderFromPeer 是 user_id=0 的回归测试。
//
// from_id 是 Telegram message 构造器的【可选】字段 —— 私聊里通常不发,
// 因为对话对方就是发送者。只读 from_id 的话 SenderID 是 0,而上传要靠
// 它查用户网盘,结果是「用户 0 没有绑定网盘」:文件下载成功却永远传不上去。
//
// 生产实测:一条真实消息的 source_ref 从 peer 取到了正确的 7428626313,
// 而 user_id 是 0 —— 就是这个缺失。
func TestFromMessageInfersSenderFromPeer(t *testing.T) {
	msg := &tg.Message{
		ID:     4542,
		PeerID: &tg.PeerUser{UserID: 7428626313},
	}
	// 刻意不设 from_id(flag 4)—— 私聊里的真实形态。
	msg.SetMedia(&tg.MessageMediaDocument{Document: &tg.Document{ID: 1, Size: 10}})

	info, ok := fromMessage(msg)
	if !ok {
		t.Fatal("应能提取")
	}
	if info.SenderID != 7428626313 {
		t.Errorf("SenderID = %d,期望从 peer 兜底成 7428626313 —— "+
			"否则 user_id=0,上传会因为「用户 0 没有绑定网盘」失败", info.SenderID)
	}
	if info.ChatID != 7428626313 {
		t.Errorf("ChatID = %d", info.ChatID)
	}
}

// TestFromMessageDoesNotInferForOutgoing 自己发的消息不能兜底成用户消息。
//
// bot 的回复 peer 也是对方,兜底会把 bot 自己的回复当成用户发的文件建任务。
func TestFromMessageDoesNotInferForOutgoing(t *testing.T) {
	msg := &tg.Message{
		ID:     1,
		PeerID: &tg.PeerUser{UserID: 7428626313},
	}
	msg.SetOut(true)
	msg.SetMedia(&tg.MessageMediaDocument{Document: &tg.Document{ID: 1, Size: 10}})

	info, _ := fromMessage(msg)
	if info.SenderID != 0 {
		t.Errorf("发出消息的 SenderID = %d,期望 0(不能兜底)", info.SenderID)
	}
	if !info.Out {
		t.Error("Out 标志丢失 —— onUpdate 靠它丢弃自己的回声,丢了就会当成用户消息")
	}
}

// TestFromMessagePrefersExplicitFromID 有 from_id 时必须用它,不能被兜底覆盖。
func TestFromMessagePrefersExplicitFromID(t *testing.T) {
	msg := &tg.Message{
		ID:     1,
		PeerID: &tg.PeerChat{ChatID: 999}, // 群聊:peer 是群,发送者是另一个人
	}
	msg.SetFromID(&tg.PeerUser{UserID: 555})
	msg.SetMedia(&tg.MessageMediaDocument{Document: &tg.Document{ID: 1, Size: 10}})

	info, _ := fromMessage(msg)
	if info.SenderID != 555 {
		t.Errorf("SenderID = %d,期望显式的 555", info.SenderID)
	}
}

func TestFromMessageRejectsEmpty(t *testing.T) {
	if _, ok := fromMessage(&tg.MessageEmpty{ID: 1}); ok {
		t.Error("空消息不该被接受")
	}
}

// TestNewRejectsMissingDeps 配置不全必须硬失败。
func TestNewRejectsMissingDeps(t *testing.T) {
	// 缺仓储
	if _, err := New(Config{Session: loadSession(t), Log: quiet()}); err == nil {
		t.Error("缺 Repo 应报错")
	}
	// 缺 session
	if _, err := New(Config{Log: quiet()}); err == nil {
		t.Error("缺 session 应报错")
	}
}

// TestNullableString 空串必须是无效值 —— 否则会往 D1 写空串,
// 与「没有值」混淆。
func TestNullableString(t *testing.T) {
	if nullableString("").Valid {
		t.Error("空串不该是有效值")
	}
	if !nullableString("x").Valid {
		t.Error("非空串应是有效值")
	}
}

// newEchoApp 造一个只够测 onUpdate 的 App。
//
// tg 刻意给零值(而不是 nil):SelfID() 返回 0,模拟「客户端还没连上」——
// 那正是 createTaskFrom 里的 SelfID 守卫失效的时刻,只有 Out 判据兜得住。
func newEchoApp(buf *strings.Builder, repo *fakeRepo, drives *fakeDrives) *App {
	return &App{
		log: slog.New(slog.NewTextHandler(buf,
			&slog.HandlerOptions{Level: slog.LevelDebug})),
		repo:     repo,
		drives:   drives,
		notifier: &fakeNotifier{},
		pending:  make(chan string, pendingQueueSize),
		tg:       &tgclient.Client{},
	}
}

// boundDrive 是「用户有盘」的最小形态 —— 门禁要靠它放行。
func boundDrive() *fakeDrives {
	return &fakeDrives{drive: &drive.Drive{Type: "protondrive"}}
}

// fakeNotifier 记录发给用户的提示 —— 没绑盘的提示是本包唯一给用户
// 发消息的地方,它的内容会直接进用户眼睛。
type fakeNotifier struct {
	chatID int64
	texts  []string
}

func (f *fakeNotifier) SendMessage(_ context.Context, chatID int64, text string) error {
	f.chatID = chatID
	f.texts = append(f.texts, text)
	return nil
}

// TestOnUpdateDropsSelfEcho 自己发出的消息不能当成用户消息。
//
// 生产现场:每次 bot 回复完,日志里紧跟一条
// 「收到消息 msgId:4572 chatId:0 senderId:0 hasMedia:false text:""」。
//
// 这不是用户发的,是回声:gotd 的 SendMessage 结尾就是
// processUpdates(telegram/send_message.go),服务端返回的
// UpdateShortSentMessage 被 upconv 转成一条 Out=true、没有 PeerID
// 的合成 UpdateNewMessage,又绕回了 onUpdate。
//
// 危害不只是噪音:合成消息可以带媒体,那时就会用 user_id=0 建任务,
// 文件下载完因为「用户 0 没有绑定网盘」永远传不上去 —— 而日志里一切正常。
//
// JS 侧在入口丢弃(MessageHandler.handleEvent 的 message.out === true),
// Go 侧之前照单全收。
func TestOnUpdateDropsSelfEcho(t *testing.T) {
	cases := []struct {
		name  string
		media bool
	}{
		{"回声带媒体(会建 user_id=0 的任务)", true},
		{"回声是纯文本(污染到达日志)", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var buf strings.Builder
			repo := &fakeRepo{}
			a := newEchoApp(&buf, repo, boundDrive())

			// 合成消息的真实形态:有 ID、有 Out,没有 PeerID。
			msg := &tg.Message{ID: 4572}
			msg.SetOut(true)
			if tc.media {
				msg.SetMedia(&tg.MessageMediaDocument{
					Document: &tg.Document{ID: 1, Size: 10},
				})
			}
			u := tgclient.Update{
				Kind: tgclient.KindNewMessage,
				Raw:  &tg.UpdateNewMessage{Message: msg},
			}

			if err := a.onUpdate(context.Background(), u); err != nil {
				t.Fatalf("不该报错:%v", err)
			}
			if len(repo.created) != 0 {
				t.Errorf("回声建了 %d 个任务:%+v —— user_id 会是 0,文件永远传不上去",
					len(repo.created), repo.created)
			}
			if out := buf.String(); strings.Contains(out, "收到消息") {
				t.Errorf("回声被记成「收到消息」:%q —— 排查时会以为用户在发消息", out)
			}
		})
	}
}

// TestOnUpdateKeepsIncomingMessages 守卫不能误伤正常消息。
//
// 上面那条守卫加在入口,最容易犯的错是顺手写成「有 Out 字段就丢」——
// 而 Out 是 flag 位,正常消息里根本没有这个字段。这里用一个和回声
// 同形态(无 from_id、私聊)的真实消息守住:它必须照常建任务。
func TestOnUpdateKeepsIncomingMessages(t *testing.T) {
	var buf strings.Builder
	repo := &fakeRepo{}
	a := newEchoApp(&buf, repo, boundDrive())

	msg := &tg.Message{
		ID:     4571,
		PeerID: &tg.PeerUser{UserID: 7428626313},
	}
	msg.SetMedia(&tg.MessageMediaDocument{
		Document: &tg.Document{ID: 7, Size: 10},
	})
	u := tgclient.Update{
		Kind: tgclient.KindNewMessage,
		Raw:  &tg.UpdateNewMessage{Message: msg},
	}

	if err := a.onUpdate(context.Background(), u); err != nil {
		t.Fatal(err)
	}
	if len(repo.created) != 1 {
		t.Fatalf("用户消息应建 1 个任务,实际 %d", len(repo.created))
	}
	if got := repo.created[0].UserID; got != "7428626313" {
		t.Errorf("user_id = %q,期望 7428626313 —— 写成 0 会让上传静默失败", got)
	}
	if !strings.Contains(buf.String(), "收到消息") {
		t.Error("用户消息必须留到达日志 —— 否则「用户在不在用」看不见")
	}
}

// TestCreateTaskRefusesWithoutDrive 没绑盘不建任务,并且【必须告诉用户】。
//
// JS 侧 _handleMediaMessage 就是这么做的(发 no_drive_found、不建任务)。
// Go 之前一句不说:文件先被完整下载,上传阶段才失败,而用户那边什么都
// 收不到 —— 只看到「发了文件没反应」,这正是最难排查的那类故障。
func TestCreateTaskRefusesWithoutDrive(t *testing.T) {
	var buf strings.Builder
	repo := &fakeRepo{}
	nf := &fakeNotifier{}
	a := newEchoApp(&buf, repo, &fakeDrives{}) // 没有任何盘
	a.notifier = nf

	// mediaUpdate 的 peer 是 chat 999、发送者是 555。
	if err := a.createTaskFrom(context.Background(), mediaUpdate(42, 555)); err != nil {
		t.Fatal(err)
	}
	if len(repo.created) != 0 {
		t.Fatalf("没绑盘却建了 %d 个任务 —— 文件会被白下载一遍再失败",
			len(repo.created))
	}
	if len(nf.texts) != 1 {
		t.Fatalf("提示发了 %d 条,期望 1 条(用户必须知道为什么没反应)", len(nf.texts))
	}
	if !strings.Contains(nf.texts[0], "绑定网盘") {
		t.Errorf("提示内容 = %q,应告诉用户去绑定网盘", nf.texts[0])
	}
	if nf.chatID != 999 {
		t.Errorf("提示发到了 chat %d,期望 999", nf.chatID)
	}
}

// TestFlushMediaGroupRefusesWithoutDrive 媒体组刷盘要过同一道门。
//
// 组是缓冲窗口之后才刷的,这期间用户可能刚解绑 —— 所以刷盘时必须
// 重新查一次,只在入口查一次是不够的。
func TestFlushMediaGroupRefusesWithoutDrive(t *testing.T) {
	var buf strings.Builder
	repo := &fakeRepo{}
	nf := &fakeNotifier{}
	a := newEchoApp(&buf, repo, &fakeDrives{})
	a.notifier = nf

	err := a.flushMediaGroup(context.Background(), "g1", task.GroupMeta{
		GID: "g1", ChatID: 999, UserID: 555,
	}, []int64{42})
	if err != nil {
		t.Fatal(err)
	}
	if len(repo.batch) != 0 {
		t.Errorf("没绑盘却建了 %d 个批次任务", len(repo.batch))
	}
	if len(nf.texts) != 1 {
		t.Fatalf("提示发了 %d 条,期望 1 条", len(nf.texts))
	}
}

// TestRunRefusesWithoutCoordinator 没协调器必须拒绝运行。
//
// 这是防双实例并发的最后一道闸:没有锁就连接 Telegram,会和 Node
// 同时处理同一批消息,表现为「同一个文件被传两次」。
func TestRunRefusesWithoutCoordinator(t *testing.T) {
	a, err := New(Config{
		APIID:   1,
		APIHash: "h",
		Session: loadSession(t),
		Repo:    nil,
		Log:     quiet(),
	})
	if err != nil {
		// 缺 Repo 时构造就该失败,这也是对的
		return
	}
	if err := a.Run(context.Background()); err == nil {
		t.Error("缺协调器时 Run 应报错")
	}
}
