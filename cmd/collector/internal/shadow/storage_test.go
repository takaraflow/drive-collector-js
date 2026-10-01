package shadow

import (
	"context"
	"crypto/sha1"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/gotd/td/session"

	"github.com/youngsx/drive-collector/cmd/collector/internal/tgsession"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// sampleSession 用真实向量构造 session,避免手编 base64 ——
// 手编的串解不出 256 字节 key,测试会假失败。
func sampleSession(t *testing.T) *tgsession.Session {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(
		"..", "..", "..", "..", "testdata", "tgsession_vectors.json"))
	if err != nil {
		t.Fatalf("读取向量失败: %v", err)
	}
	var v struct {
		Cases []struct {
			S string `json:"s"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Cases) == 0 {
		t.Fatal("向量为空,需重跑 npm run test:vectors:tgsession")
	}
	s, err := tgsession.Parse(v.Cases[0].S)
	if err != nil {
		t.Fatalf("解析向量 session 失败: %v", err)
	}
	return s
}

// TestReadOnlyStorageFeedsGotdsFormat 确认我们产出的字节确实能被
// gotd 的 Loader 解析 —— 格式错了的话连上也是用错 authKey。
func TestReadOnlyStorageFeedsGotdsFormat(t *testing.T) {
	st, err := NewReadOnlyStorage(sampleSession(t), quietLogger())
	if err != nil {
		t.Fatalf("构造 storage 失败: %v", err)
	}

	loader := &session.Loader{Storage: st}
	data, err := loader.Load(context.Background())
	if err != nil {
		t.Fatalf("gotd Loader 无法解析我们产出的格式: %v", err)
	}
	if len(data.AuthKey) != 256 {
		t.Errorf("gotd 读到 %d 字节 authKey,期望 256", len(data.AuthKey))
	}
	if data.DC == 0 {
		t.Error("gotd 读到的 DC 为 0")
	}
	if data.Addr == "" {
		t.Error("gotd 读到的 Addr 为空")
	}
}

// TestAuthKeyIDPassesGotdValidation 是「影子模式能不能连上」的唯一真判据。
//
// gotd 的 telegram/session.go 恢复连接时会校验
// `key.Value.ID() != key.ID`,不等就返回 "corrupted key" 直接失败。
// 之前的测试只检查 LoadSession 返回的字节,从没让 gotd 走过那条路,
// 所以 AuthKeyID 留空这个致命 bug 能一直存在而测试全绿。
func TestAuthKeyIDPassesGotdValidation(t *testing.T) {
	sess := sampleSession(t)
	st, err := NewReadOnlyStorage(sess, quietLogger())
	if err != nil {
		t.Fatal(err)
	}
	data, err := (&session.Loader{Storage: st}).Load(context.Background())
	if err != nil {
		t.Fatalf("gotd Loader 解析失败: %v", err)
	}

	// 复刻 gotd 的校验逻辑,而不是只断言字段非空 ——
	// 断言非空挡不住「算错但非空」的情况。
	var key struct {
		ID    [8]byte
		Value [256]byte
	}
	copy(key.ID[:], data.AuthKeyID)
	copy(key.Value[:], data.AuthKey)

	sum := sha1.Sum(data.AuthKey)
	var want [8]byte
	copy(want[:], sum[12:])

	if key.ID != want {
		t.Errorf("auth_key_id 不匹配:\n  got  %x\n  want %x\n"+
			"gotd 会返回 \"corrupted key\",影子模式连不上。", key.ID, want)
	}
}

// TestAuthKeyIDDerivation 直接验证 SHA1(authkey)[12:20]。
func TestAuthKeyIDDerivation(t *testing.T) {
	key := make([]byte, 256)
	for i := range key {
		key[i] = byte(i)
	}
	s := &tgsession.Session{AuthKey: key}

	sum := sha1.Sum(key)
	got := s.AuthKeyID()
	if len(got) != 8 {
		t.Fatalf("auth_key_id 长度 = %d,期望 8", len(got))
	}
	for i := 0; i < 8; i++ {
		if got[i] != sum[12+i] {
			t.Fatalf("第 %d 字节 = %x,期望 %x", i, got[i], sum[12+i])
		}
	}
}
// TestStoreSessionIsNoOp 是影子模式最关键的一条铁律。
//
// 一旦有人给这个类型加上真正的写逻辑,session 就会被 Go 侧覆盖,
// Node 下次加载到不一致的 authKey → AUTH_KEY_DUPLICATED → 线上实例
// 被踢下线。所以这个断言必须存在。
func TestStoreSessionIsNoOp(t *testing.T) {
	st, err := NewReadOnlyStorage(sampleSession(t), quietLogger())
	if err != nil {
		t.Fatal(err)
	}

	before, _ := st.LoadSession(context.Background())
	if err := st.StoreSession(context.Background(), []byte("garbage")); err != nil {
		t.Fatalf("StoreSession 应返回 nil,得到 %v", err)
	}
	after, _ := st.LoadSession(context.Background())

	if st.StoreCalls() != 1 {
		t.Errorf("StoreCalls = %d,期望 1(确认 gotd 确实调过)", st.StoreCalls())
	}
	if string(before) != string(after) {
		t.Error("StoreSession 之后 session 内容变了 —— 这是铁律 3 的违反")
	}
}

// TestNilSessionRejected 缺 session 必须报错,不能返回空 storage。
func TestNilSessionRejected(t *testing.T) {
	if _, err := NewReadOnlyStorage(nil, quietLogger()); err == nil {
		t.Error("nil session 应被拒绝")
	}
}

// TestAddrIncludesPort gotd 的 Addr 期望 host:port,漏端口会连不上。
func TestAddrIncludesPort(t *testing.T) {
	s := &tgsession.Session{DCID: 2, ServerAddr: "149.154.175.116", Port: 443}
	st, err := NewReadOnlyStorage(s, quietLogger())
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := st.LoadSession(context.Background())

	var got struct {
		Data session.Data
	}
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.Addr != "149.154.175.116:443" {
		t.Errorf("Addr = %q,期望 \"149.154.175.116:443\"", got.Data.Addr)
	}
}
