package app

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
)

// protonPlainPassword 是测试用的明文密码。
const protonPlainPassword = "Sup3rSecret!"

// protonObscuredSample 是 protonPlainPassword 经【真 rclone v1.71.1】
// `rclone obscure` 得到的输出（逐字节原样粘进来的常量）：
//
//	$ rclone obscure -- 'Sup3rSecret!'
//	5j3vudjNBx1PIELa_tKpcIHUMYwb5-mGl0WEnw
//	$ rclone reveal -- '5j3vudjNBx1PIELa_tKpcIHUMYwb5-mGl0WEnw'
//	Sup3rSecret!
//
// 为什么要用真 rclone 造的值:假 rclone 如果回一句 "obscured:$5"，
// 那么「写成 obſcured:明文」和「真的混淆过」在这个测试里长得一模一样，
// 而线上那个非法 base64 恰恰是「长得像」的那类值。用真样本才能钉死格式。
const protonObscuredSample = "5j3vudjNBx1PIELa_tKpcIHUMYwb5-mGl0WEnw"

// looksLikeRcloneObscured 复刻 rclone reveal() 的两个前置条件，
// 逐字照抄 fs/config/obscure/obscure.go 的 Reveal()：
//
//	base64.RawURLEncoding.DecodeString(x)   // ① 纯 base64url，无 '=' 补位
//	if len(ciphertext) < aes.BlockSize { ... } // ② 解码后至少 16 字节（IV）
//
// 测试里重现它，是为了让「明文被写进 conf」这个 bug 产生和线上
// 同一类的失败（illegal base64），而不是靠断言字符串匹配。
func looksLikeRcloneObscured(s string) error {
	if _, err := base64.RawURLEncoding.DecodeString(s); err != nil {
		return fmt.Errorf("not base64url: %w", err)
	}
	decoded, _ := base64.RawURLEncoding.DecodeString(s)
	if len(decoded) < 16 {
		return fmt.Errorf("decoded %d bytes, 少于 AES BlockSize(16)", len(decoded))
	}
	return nil
}

// protonFakeRclone 造一个假 rclone,并把「rclone 真正看到的那份临时 conf」
// 抓下来 —— 抓完再把 session 四件套追加进【同一个段】,模拟 rclone 旋转 token
// 后回写的行为。
func protonFakeRclone(t *testing.T, confCapture string, session map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "rclone")
	var b strings.Builder
	b.WriteString("#!/bin/sh\n")
	// obscure 回【真 rclone 造的值】，不是带明文的假串 —— 理由见 protonObscuredSample。
	b.WriteString("if [ \"$3\" = \"obscure\" ]; then\n  echo '" + protonObscuredSample + "'\n  exit 0\nfi\n")
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
// 里,密码必须是 rclone 真正能 reveal 回去的混淆值。
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

	_, reason, details := p.ValidateProton(ctx, "user@proton.me", protonPlainPassword, "")
	if reason != "" {
		t.Fatalf("验证失败: reason=%s details=%s", reason, details)
	}

	conf, err := os.ReadFile(capture)
	if err != nil {
		t.Fatalf("没抓到 conf: %v", err)
	}
	body := string(conf)

	// 从抓到的 conf 里解析出 password,而不是整行匹配 ——
	// rclone 只认这个值,断言就该对着它成立。
	got := parseConfValue(body, "password")
	if got == "" {
		t.Fatalf("conf 里没有 password:\n%s", body)
	}
	if got == protonPlainPassword {
		t.Fatalf("明文密码进了临时 conf:\n%s", body)
	}
	// 复刻 reveal() 的前置条件:这一条挂了,线上就是 illegal base64 data。
	if err := looksLikeRcloneObscured(got); err != nil {
		t.Errorf("conf 里的密码 reveal 不了(%v),线上会报 illegal base64 data:\n%s", err, body)
	}
	if got != protonObscuredSample {
		t.Errorf("conf 里的密码 = %q,期望真 rclone 的 obscure 输出 %q", got, protonObscuredSample)
	}
}

// parseConfValue 从 conf 文本里取 key 的值(测试用,只认最简形式)。
func parseConfValue(conf, key string) string {
	for _, line := range strings.Split(conf, "\n") {
		if strings.HasPrefix(strings.TrimSpace(line), key+" = ") {
			return strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), key+" = "))
		}
	}
	return ""
}

// TestValidateProtonRejectsBlankCredentials 没有凭据必须立刻失败。
//
// 少一步就会走到 obscure 空密码那一步,报错信息会指向混淆而不是缺输入。
func TestValidateProtonRejectsBlankCredentials(t *testing.T) {
	for _, tc := range []struct {
		name     string
		user     string
		pass     string
		twoF     string
		wantFail bool
	}{
		{name: "空用户名", user: "", pass: "pw", wantFail: true},
		{name: "空密码", user: "u@x.com", pass: "", wantFail: true},
		{name: "空白用户名", user: "   ", pass: "pw", wantFail: true},
		{name: "空白密码", user: "u@x.com", pass: "  \t ", wantFail: true},
		// 输入两端空白要被 trim 掉 —— 写进 conf 的不能是带空格的版本。
		{name: "带空白但非空", user: "  u@x.com  ", pass: "  pw  "},
		// 空白密码会被 trim 到空,所以它必须像空密码一样失败。
		{name: "trim 后为空", user: "u@x.com", pass: " \t\n ", wantFail: true},
		{name: "2FA 照常通过", user: "u@x.com", pass: "pw", twoF: "123456"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			capture := filepath.Join(t.TempDir(), "seen.conf")
			p := newTestProtonRuntime(protonFakeRclone(t, capture, nil))

			_, reason, _ := p.ValidateProton(context.Background(), tc.user, tc.pass, tc.twoF)
			if tc.wantFail {
				if reason == "" {
					t.Fatalf("应该失败,却通过了")
				}
				return
			}
			if reason != "" {
				t.Fatalf("应该通过,却失败: %s", reason)
			}
			body, _ := os.ReadFile(capture)
			if got := parseConfValue(string(body), "username"); got != "u@x.com" {
				t.Errorf("conf 里的 username = %q,期望 trim 后的 u@x.com", got)
			}
		})
	}
}

// TestValidateProtonOmitsEmptyTwoFactor conf 里不该出现空的 2fa。
//
// 空值不写进去,是 rclone runtime 层 buildConf 的既有约定
// (runtime_test.go 有对应覆盖);这里从调用侧钉住「有验证码才写」。
func TestValidateProtonOmitsEmptyTwoFactor(t *testing.T) {
	capture := filepath.Join(t.TempDir(), "seen.conf")
	p := newTestProtonRuntime(protonFakeRclone(t, capture, nil))

	if _, reason, _ := p.ValidateProton(context.Background(), "u@x.com", "pw", ""); reason != "" {
		t.Fatalf("验证失败: %s", reason)
	}
	body, _ := os.ReadFile(capture)
	if got := parseConfValue(string(body), "2fa"); got != "" {
		t.Errorf("没给验证码时 conf 里却有 2fa = %q", got)
	}

	capture2 := filepath.Join(t.TempDir(), "seen2.conf")
	p2 := newTestProtonRuntime(protonFakeRclone(t, capture2, nil))
	if _, reason, _ := p2.ValidateProton(context.Background(), "u@x.com", "pw", "123456"); reason != "" {
		t.Fatalf("验证失败: %s", reason)
	}
	body2, _ := os.ReadFile(capture2)
	if got := parseConfValue(string(body2), "2fa"); got != "123456" {
		t.Errorf("conf 里的 2fa = %q,期望 123456", got)
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
  echo '` + protonObscuredSample + `'
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
