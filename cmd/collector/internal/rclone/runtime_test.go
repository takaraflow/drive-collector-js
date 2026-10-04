package rclone

import (
	"os"
	"strings"
	"testing"
)

// TestRuntimeWritesAndReadsBack 临时 conf 的写-读往返。
//
// 这是 Proton session 收割的地基:rclone 跑完会把新 token 写进这个
// 文件,我们必须能原样读回来。读错一个字符,存进库的就是坏 token,
// 而症状是「下次上传认证失败」—— 和「token 过期」长得一模一样。
func TestRuntimeWritesAndReadsBack(t *testing.T) {
	rt, err := NewRuntime("u123", map[string]string{
		"type":                 "protondrive",
		"client_uid":           "uid-abc",
		"client_refresh_token": "refresh-xyz",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Dispose()

	// 模拟 rclone 旋转了 token
	if err := os.WriteFile(rt.ConfigPath, []byte(
		"[u123]\ntype = protondrive\nclient_uid = uid-abc\nclient_refresh_token = refresh-NEW\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got, err := rt.ReadSection()
	if err != nil {
		t.Fatal(err)
	}
	if got["client_refresh_token"] != "refresh-NEW" {
		t.Errorf("读回的 token = %q,期望 refresh-NEW", got["client_refresh_token"])
	}
	if got["client_uid"] != "uid-abc" {
		t.Errorf("client_uid = %q", got["client_uid"])
	}
}

// TestRuntimeEscapesSpecialChars 含特殊字符的值必须能原样往返。
//
// 密码和 token 里出现空格、引号、反斜杠是常事。转义少一步会让值被
// 截断,而 rclone 那边【不报错】,只是认证失败 —— 排查时完全看不出
// 是「我们写 conf 时把密码写坏了」。
func TestRuntimeEscapesSpecialChars(t *testing.T) {
	tricky := `pa ss"wo\rd#x;y`

	rt, err := NewRuntime("u1", map[string]string{"password": tricky})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Dispose()

	got, err := rt.ReadSection()
	if err != nil {
		t.Fatal(err)
	}
	if got["password"] != tricky {
		t.Errorf("往返后 = %q,期望 %q", got["password"], tricky)
	}
}

// TestRuntimeSkipsEmptyValues 空值不写进 conf。
//
// 写了空值会让 rclone 用它覆盖自己的默认值 —— 比如空的 thumb_size
// 可能让它去要一个不存在的缩略图尺寸。
func TestRuntimeSkipsEmptyValues(t *testing.T) {
	rt, err := NewRuntime("u1", map[string]string{
		"type":     "protondrive",
		"username": "",
		"password": "p",
	})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Dispose()

	raw, err := os.ReadFile(rt.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "username") {
		t.Errorf("空值不该写进 conf:\n%s", raw)
	}
	if !strings.Contains(string(raw), "password = p") {
		t.Errorf("非空值应写入:\n%s", raw)
	}
}

// TestRuntimeTargetUsesRemoteName 目标必须用 conf 里的段名。
//
// 用连接串的话 rclone 会忽略 --config,拿不到 session —— 于是又回到
// 「用密码登录」,多一次 refresh_token 旋转机会。
func TestRuntimeTargetUsesRemoteName(t *testing.T) {
	rt, err := NewRuntime("u7428626313", map[string]string{"type": "protondrive"})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Dispose()

	got := rt.Target("/DriveCollectorBot", "a.mp4")
	if got != "u7428626313:DriveCollectorBot/a.mp4" {
		t.Errorf("Target = %q", got)
	}
	if strings.Contains(got, ":/") {
		t.Errorf("段名后不该有 '/':%q", got)
	}
}

// TestRuntimeDisposeRemovesTempDir 临时目录必须被清掉。
//
// conf 里有 session 凭据,留在盘上既是泄漏也是磁盘占用。
func TestRuntimeDisposeRemovesTempDir(t *testing.T) {
	rt, err := NewRuntime("u1", map[string]string{"type": "protondrive"})
	if err != nil {
		t.Fatal(err)
	}
	dir := rt.dir

	rt.Dispose()

	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("临时目录还在:%s", dir)
	}
	// 重复 Dispose 不该 panic(harvest 里用了 defer)
	rt.Dispose()
}

// TestParseConfSectionIgnoresOtherSections 只读自己那一段。
//
// rclone 可能往同一个 conf 里写别的段(比如它自己的缓存配置),
// 读串了会把别人的值当成自己的 token。
func TestParseConfSectionIgnoresOtherSections(t *testing.T) {
	text := `[other]
client_refresh_token = WRONG

[u1]
client_refresh_token = RIGHT
`
	got := parseConfSection(text, "u1")
	if got["client_refresh_token"] != "RIGHT" {
		t.Errorf("读到了别的段的值:%q", got["client_refresh_token"])
	}
}
