package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
)

// protonFakeRclone 造一个假 rclone,并把「rclone 真正看到的那份临时 conf」
// 抓下来 —— 抓完再把 session 四件套追加进【同一个段】,模拟 rclone 旋转 token
// 后回写的行为。
func protonFakeRclone(t *testing.T, confCapture string, session map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "rclone")
	var b strings.Builder
	b.WriteString("#!/bin/sh\n")
	b.WriteString("if [ \"$3\" = \"obscure\" ]; then\n  echo \"obscured:$5\"\n  exit 0\nfi\n")
	b.WriteString("conf=\n")
	b.WriteString("for a in \"$@\"; do\n  case \"$a\" in\n    /tmp/rclone-rt-*/rclone.conf) cp \"$a\" " + confCapture + "; conf=\"$a\" ;;\n  esac\ndone\n")
	// 追加到 rclone 被给到的【那个】 conf —— 模拟它把旋转后的 token 回写进去。
	// 写到副本上没用:收割读的是真实临时 conf。
	for k, v := range session {
		b.WriteString("echo '" + k + " = " + v + "' >> \"$conf\"\n")
	}
	b.WriteString("echo '{\"level\":\"info\",\"msg\":\"about\"}'\nexit 0\n")
	if err := os.WriteFile(bin, []byte(b.String()), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func newTestProtonRuntime(bin string) *protonRuntime {
	return newProtonRuntime(&rclone.Runner{
		Binary: bin,
		Env:    append(os.Environ(), "RCLONE_CONFIG_PASS="),
	})
}

// TestValidateProtonObscuresPasswordBeforeWritingConf 绑定验证的临时 conf
// 里,密码必须是 obscure 过的。
//
// 线上事故:rclone 报 "couldn't decrypt password: base64 decode failed
// when revealing password - is it obscured?: illegal base64 data at input
// byte 16" —— 因为明文被原样写进了 conf。rclone 从 conf 读密码一律走
// reveal(解密),不认明文,所以用户名/密码/2FA 全对也过不去。
func TestValidateProtonObscuresPasswordBeforeWritingConf(t *testing.T) {
	capture := filepath.Join(t.TempDir(), "seen.conf")
	bin := protonFakeRclone(t, capture, nil)

	p := newTestProtonRuntime(bin)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, reason, details := p.ValidateProton(ctx, "user@proton.me", "Sup3rSecret!", "")
	if reason != "" {
		t.Fatalf("验证失败: reason=%s details=%s", reason, details)
	}

	conf, err := os.ReadFile(capture)
	if err != nil {
		t.Fatalf("没抓到 conf: %v", err)
	}
	body := string(conf)
	// obscure 是带前缀的 AES 结果,明文恰好是它的后缀 ——
	// 所以只能按【整行】判,不能按子串判。
	if strings.Contains(body, "\npassword = Sup3rSecret!\n") {
		t.Errorf("明文密码进了临时 conf:\n%s", body)
	}
	if !strings.Contains(body, "password = obscured:Sup3rSecret!") {
		t.Errorf("conf 里的密码不是 obscure 过的:\n%s", body)
	}
}

// TestValidateProtonRejectsBlankCredentials 没有凭据必须立刻失败。
//
// 少一步就会走到 obscure 空密码那一步,报错信息会指向混淆而不是缺输入。
func TestValidateProtonRejectsBlankCredentials(t *testing.T) {
	bin := protonFakeRclone(t, filepath.Join(t.TempDir(), "seen.conf"), nil)
	p := newTestProtonRuntime(bin)

	for _, tc := range []struct{ user, pass string }{
		{"", "pw"},
		{"u@x.com", ""},
		{"   ", "pw"},
	} {
		_, reason, _ := p.ValidateProton(context.Background(), tc.user, tc.pass, "")
		if reason == "" {
			t.Errorf("user=%q pass=%q 应该失败,却通过了", tc.user, tc.pass)
		}
	}
}

// TestValidateProtonHarvestsRotatedSession 验证成功后要能把 rclone 写回的
// session 四件套收上来 —— 2FA 账号靠它才能以后不输验证码。
func TestValidateProtonHarvestsRotatedSession(t *testing.T) {
	capture := filepath.Join(t.TempDir(), "seen.conf")
	bin := protonFakeRclone(t, capture, map[string]string{
		"client_uid":             "uid-1",
		"client_access_token":    "at-1",
		"client_refresh_token":   "rt-1",
		"client_salted_key_pass": "skp-1",
	})

	p := newTestProtonRuntime(bin)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	session, reason, details := p.ValidateProton(ctx, "user@proton.me", "pw", "123456")
	if reason != "" {
		t.Fatalf("验证失败: reason=%s details=%s", reason, details)
	}
	if len(session) != 4 || session["client_refresh_token"] != "rt-1" {
		t.Errorf("session 收割不完整: %#v", session)
	}
}

// TestValidateProtonClassifies2FAError 报 2FA 的错误要让用户重输验证码,
// 而不是笼统的「验证失败」。
func TestValidateProtonClassifies2FAError(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "rclone")
	script := `#!/bin/sh
if [ "$3" = "obscure" ]; then
  echo "obscured:$5"
  exit 0
fi
echo '{"level":"error","msg":"Failed to create file system","error":"Multi-factor authentication required for user"}' >&2
exit 1
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	p := newTestProtonRuntime(bin)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, reason, _ := p.ValidateProton(ctx, "user@proton.me", "pw", "000000")
	if reason != "2FA" {
		t.Errorf("reason = %q,期望 2FA", reason)
	}
}
