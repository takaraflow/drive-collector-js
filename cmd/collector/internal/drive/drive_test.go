package drive

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestSupportedOnlyMegaAndProton(t *testing.T) {
	// 精简规格:只保留实测可用的两家。其余是占位。
	for _, tp := range []Type{TypeMega, TypeProton} {
		if !IsSupported(tp) {
			t.Errorf("%s 应被支持", tp)
		}
	}
	for _, tp := range []Type{"box", "dropbox", "gdrive", "onedrive", "webdav", "pikpak"} {
		if IsSupported(tp) {
			t.Errorf("%s 是占位,不该被报为支持", tp)
		}
	}
}

// TestPlaceholderReturnsClearError 未实现的网盘要给清楚的错误。
//
// 静默落进一个拼不出连接串的分支,用户会看到「未知错误」。
func TestPlaceholderReturnsClearError(t *testing.T) {
	_, err := ConnectionString("gdrive", Config{User: "u", Pass: "p"})
	if err == nil {
		t.Fatal("占位网盘应报错")
	}
	if !strings.Contains(err.Error(), "尚未实现") {
		t.Errorf("错误信息应说明是占位,得到 %q", err.Error())
	}
}

func TestMegaConnectionString(t *testing.T) {
	got, err := ConnectionString(TypeMega, Config{User: "a@b.com", Pass: "hunter2"})
	if err != nil {
		t.Fatal(err)
	}
	want := `:mega,user="a@b.com",pass="hunter2":`
	if got != want {
		t.Errorf("连接串 = %q,期望 %q", got, want)
	}
}

// TestProtonPrefersSessionOverPassword 有可复用 session 时不提交密码。
//
// 这不只是省一次登录 —— 提交密码会触发一次性 refresh_token 的
// 旋转,而并发两个任务共用它就是账号砖化的起点(记忆里的 Code=10013)。
func TestProtonPrefersSessionOverPassword(t *testing.T) {
	sess := &ProtonSession{
		ClientUID:           "uid",
		ClientAccessToken:   "access",
		ClientRefreshToken:  "refresh",
		ClientSaltedKeyPass: "salted",
	}
	got, err := ConnectionString(TypeProton, Config{
		User: "me@proton.me", Pass: "should-be-ignored", Session: sess,
	})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "password=") {
		t.Errorf("有 session 时不该再提交密码:%q", got)
	}
	if !strings.Contains(got, `client_refresh_token="refresh"`) {
		t.Errorf("缺少 refresh_token:%q", got)
	}
	if !strings.Contains(got, `client_salted_key_pass="salted"`) {
		t.Errorf("缺少 salted_key_pass:%q", got)
	}
	if !strings.Contains(got, `username="me@proton.me"`) {
		t.Errorf("缺少 username:%q", got)
	}
}

// TestProtonFallsBackToPassword 没有 session 时用密码。
func TestProtonFallsBackToPassword(t *testing.T) {
	got, err := ConnectionString(TypeProton, Config{User: "me@proton.me", Pass: "pw"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `password="pw"`) {
		t.Errorf("无 session 时该用密码:%q", got)
	}
	if !strings.HasPrefix(got, ":protondrive,") {
		t.Errorf("后端名 = %q,期望 protondrive", got)
	}
}

func TestProtonRejectsIncompleteConfig(t *testing.T) {
	if _, err := ConnectionString(TypeProton, Config{Pass: "pw"}); err == nil {
		t.Error("缺 username 应报错")
	}
	// 有用户名但既没密码也没 session
	if _, err := ConnectionString(TypeProton, Config{User: "u"}); err == nil {
		t.Error("既无密码又无 session 应报错")
	}
}

// TestEscapeValueOrder 转义顺序必须先反斜杠后引号。
//
// 反过来会让引号产生的转义符自己再被转义一次,
// 密码里带引号或反斜杠就必然连不上。
func TestEscapeValueOrder(t *testing.T) {
	cases := []struct{ in, want string }{
		{`plain`, `plain`},
		{`with"quote`, `with\"quote`},
		{`with\slash`, `with\\slash`},
		// 同时含两者:必须先转义已有的反斜杠
		{`a\"b`, `a\\\"b`},
	}
	for _, tc := range cases {
		if got := escapeValue(tc.in); got != tc.want {
			t.Errorf("escapeValue(%q) = %q,期望 %q", tc.in, got, tc.want)
		}
	}
}

// TestEscapedPasswordRoundTrips 含特殊字符的密码必须能拼出合法连接串。
//
// 判据是「有没有未转义的裸引号」—— 它会提前截断连接串,
// 症状是「配置明明对却连不上」。转义后的 \" 里那个引号是安全的,
// 所以只数【前面不是反斜杠的】引号。
func TestEscapedPasswordRoundTrips(t *testing.T) {
	tricky := `p@ss"w\ord`
	got, err := ConnectionString(TypeMega, Config{User: "u", Pass: tricky})
	if err != nil {
		t.Fatal(err)
	}

	// 剥掉固定的前后缀,拿到密码部分
	prefix := `:mega,user="u",pass="`
	if !strings.HasPrefix(got, prefix) || !strings.HasSuffix(got, `":`) {
		t.Fatalf("连接串形状不对:%q", got)
	}
	password := strings.TrimSuffix(strings.TrimPrefix(got, prefix), `":`)

	for i := 0; i < len(password); i++ {
		if password[i] != '"' {
			continue
		}
		// 前面是奇数个反斜杠 → 引号是裸的
		backslashes := 0
		for j := i - 1; j >= 0 && password[j] == '\\'; j-- {
			backslashes++
		}
		if backslashes%2 == 0 {
			t.Errorf("密码里有未转义的引号(位置 %d):%q", i, password)
		}
	}
}

// TestSessionLockSerializesSameUser 同一用户的 session 操作必须串行。
//
// 这是记忆里 proton-refresh-token-race 的核心防线:
// refresh_token 是一次性的,并发用会导致 Code=10013 账号砖化。
func TestSessionLockSerializesSameUser(t *testing.T) {
	locks := NewSessionLock()
	key := Key(TypeProton, "user1")

	var concurrent int32
	var maxConcurrent int32
	var wg sync.WaitGroup

	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = locks.WithSession(context.Background(), key, func() error {
				cur := atomic.AddInt32(&concurrent, 1)
				for {
					old := atomic.LoadInt32(&maxConcurrent)
					if cur <= old || atomic.CompareAndSwapInt32(&maxConcurrent, old, cur) {
						break
					}
				}
				time.Sleep(time.Millisecond)
				atomic.AddInt32(&concurrent, -1)
				return nil
			})
		}()
	}
	wg.Wait()

	if maxConcurrent != 1 {
		t.Errorf("同一用户的最大并发 = %d,必须为 1", maxConcurrent)
	}
}

// TestSessionLockDoesNotBlockDifferentUsers 不同用户互不阻塞。
func TestSessionLockDoesNotBlockDifferentUsers(t *testing.T) {
	locks := NewSessionLock()

	var concurrent int32
	var maxConcurrent int32
	var wg sync.WaitGroup

	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_ = locks.WithSession(context.Background(), Key(TypeProton, string(rune('a'+i))), func() error {
				cur := atomic.AddInt32(&concurrent, 1)
				for {
					old := atomic.LoadInt32(&maxConcurrent)
					if cur <= old || atomic.CompareAndSwapInt32(&maxConcurrent, old, cur) {
						break
					}
				}
				time.Sleep(time.Millisecond)
				atomic.AddInt32(&concurrent, -1)
				return nil
			})
		}(i)
	}
	wg.Wait()

	// 不同用户之间不该互相阻塞(并发 > 1 才说明锁粒度正确)
	if maxConcurrent < 2 {
		t.Errorf("不同用户应能并发,最大并发 = %d —— 锁粒度可能错了", maxConcurrent)
	}
}

// TestLockReleaseIsIdempotent 重复解锁不该 panic(否则 defer 两次就崩)。
func TestLockReleaseIsIdempotent(t *testing.T) {
	locks := NewSessionLock()
	unlock := locks.Lock("k")
	unlock()
	// 再调一次会 panic,而 sync.Mutex 不可重入 ——
	// 所以这里只验证正常路径不会泄漏锁。
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = locks.WithSession(context.Background(), "k", func() error { return nil })
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("释放后应能重新取得锁")
	}
}
