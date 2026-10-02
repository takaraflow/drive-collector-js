package drive

import (
	"database/sql"
	"encoding/json"
	"strings"
	"testing"
)

// 真实数据形状:取自生产 D1 的 drives.config_data。
// 字段名必须逐字对 —— 少一个或拼错,sym症状是「连不上网盘」,
// 而那看不出是配置解析的问题。
const realMegaConfig = `{
  "user": "shangxin9515@outlook.com",
  "pass": "PASSWORD_OBSCURED_64_CHARS_xxxxxxxxxxxxxxxx",
  "pass_format": "rclone_obscured",
  "config_schema_version": 1,
  "credential_verified": true
}`

const realProtonConfig = `{
  "username": "shanghsin@proton.me",
  "password": "PROTON_PASSWORD",
  "password_format": "rclone_obscured",
  "two_factor_enabled": true,
  "client_uid": "e6lrnrncmszskq4cxc4nd4wekuko3oqt",
  "client_access_token": "ACCESS_TOKEN_32",
  "client_refresh_token": "REFRESH_TOKEN_32",
  "client_salted_key_pass": "SALTED_KEY_44",
  "session_bootstrap_ok": true
}`

// TestMegaConnectionFromD1Config Mega 凭据从 D1 读出后能拼出连接串。
func TestMegaConnectionFromD1Config(t *testing.T) {
	d := &Drive{
		Type:   "mega",
		Config: DriveConfig{User: "shangxin9515@outlook.com", Pass: "OBSCURED", PassFormat: "rclone_obscured"},
	}
	got, err := ToConnectionString(d)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(got, ":mega,user=") {
		t.Errorf("后端名不对:%q", got)
	}
	if !strings.Contains(got, `user="shangxin9515@outlook.com"`) {
		t.Errorf("用户名不对:%q", got)
	}
	if !strings.Contains(got, `pass="OBSCURED"`) {
		t.Errorf("密码不对:%q", got)
	}
	// obscure 过的密码必须【原样】传 —— rclone 自己会解。
	// Go 侧若试图解码,只会得到垃圾字符,然后报「认证失败」。
	if strings.Contains(got, "OBSCURED") == false {
		t.Error("密码被改动了")
	}
}

// TestProtonPrefersSession 有 session 时不提交密码 ——
// 提交会触发一次性 refresh_token 的旋转(记忆里的 Code=10013 砖化)。
func TestProtonPrefersSession(t *testing.T) {
	d := &Drive{
		Type: "protondrive",
		Config: DriveConfig{
			Username:            "shanghsin@proton.me",
			Password:            "SHOULD_NOT_APPEAR",
			ClientUID:           "uid-1",
			ClientAccessToken:   "access",
			ClientRefreshToken:  "refresh",
			ClientSaltedKeyPass: "salted",
		},
	}
	got, err := ToConnectionString(d)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, "SHOULD_NOT_APPEAR") {
		t.Errorf("有 session 时不该提交密码:%q", got)
	}
	for _, want := range []string{
		`username="shanghsin@proton.me"`,
		`client_uid="uid-1"`,
		`client_access_token="access"`,
		`client_refresh_token="refresh"`,
		`client_salted_key_pass="salted"`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("缺少 %s\n实际: %q", want, got)
		}
	}
}

// TestProtonIncompleteSessionFallsBackToPassword session 不完整时退回密码。
//
// 「不完整」指缺 access_token 或 salted_key_pass —— 这种情况硬发
// session 会让 rclone 报「认证失败」,看不出是缺字段。
func TestProtonIncompleteSessionFallsBackToPassword(t *testing.T) {
	d := &Drive{
		Type: "protondrive",
		Config: DriveConfig{
			Username:           "u@p.me",
			Password:           "pw",
			ClientUID:          "uid",
			ClientRefreshToken: "refresh",
			// 故意缺 access_token 和 salted_key_pass
		},
	}
	got, err := ToConnectionString(d)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, `password="pw"`) {
		t.Errorf("session 不完整时该退回密码:%q", got)
	}
	if strings.Contains(got, "client_refresh_token") {
		t.Errorf("session 不完整时不该发 session 字段:%q", got)
	}
}

// TestProtonNoSessionNoPasswordRejected 既没 session 又没密码必须报错。
func TestProtonNoSessionNoPasswordRejected(t *testing.T) {
	d := &Drive{Type: "protondrive", Config: DriveConfig{Username: "u@p.me"}}
	if _, err := ToConnectionString(d); err == nil {
		t.Error("既无 session 又无密码应报错")
	}
}

// TestPlaceholderDriveRejected 占位网盘必须明确报错。
func TestPlaceholderDriveRejected(t *testing.T) {
	d := &Drive{Type: "gdrive", Config: DriveConfig{User: "u", Pass: "p"}}
	_, err := ToConnectionString(d)
	if err == nil {
		t.Fatal("占位网盘应报错")
	}
	if !strings.Contains(err.Error(), "尚未实现") {
		t.Errorf("错误信息应说明是占位:%q", err)
	}
}

// TestNilDrive 不 panic。
func TestNilDrive(t *testing.T) {
	if _, err := ToConnectionString(nil); err == nil {
		t.Error("nil drive 应报错")
	}
}

// TestRemotePathPrefersUserSetting 用户设的目录优先于全局默认。
//
// 反了的话文件会传到根目录 —— 用户看不见,而且任务显示「成功」。
func TestRemotePathPrefersUserSetting(t *testing.T) {
	d := &Drive{RemoteFolder: sqlNullString("/MyFolder")}
	if got := d.RemotePath("/GlobalDefault"); got != "/MyFolder" {
		t.Errorf("路径 = %q,期望用用户设置的", got)
	}

	// 用户没设 → 退回全局
	d2 := &Drive{}
	if got := d2.RemotePath("/GlobalDefault"); got != "/GlobalDefault" {
		t.Errorf("路径 = %q,期望用全局默认", got)
	}

	// 空字符串也该退回
	d3 := &Drive{RemoteFolder: sqlNullString("  ")}
	if got := d3.RemotePath("/GlobalDefault"); got != "/GlobalDefault" {
		t.Errorf("空目录应退回全局,得到 %q", got)
	}
}

// TestUnmarshalRealD1Config 真实 config_data 的 JSON 形状必须能解析。
//
// 这是「Go 能不能读懂 Node 写的数据」的直接判据。字段名对不上时,
// json.Unmarshal 静默忽略未知字段,结果是 User/Pass 全空,
// 然后报「连不上网盘」—— 完全看不出是解析问题。
func TestUnmarshalRealD1Config(t *testing.T) {
	var mega DriveConfig
	if err := json.Unmarshal([]byte(realMegaConfig), &mega); err != nil {
		t.Fatalf("解析 mega config 失败: %v", err)
	}
	if mega.User != "shangxin9515@outlook.com" {
		t.Errorf("user = %q", mega.User)
	}
	if mega.PassFormat != "rclone_obscured" {
		t.Errorf("pass_format = %q", mega.PassFormat)
	}
	if !mega.CredentialVerified {
		t.Error("credential_verified 丢失")
	}
	if mega.SchemaVersion != 1 {
		t.Errorf("config_schema_version = %d", mega.SchemaVersion)
	}

	var proton DriveConfig
	if err := json.Unmarshal([]byte(realProtonConfig), &proton); err != nil {
		t.Fatalf("解析 proton config 失败: %v", err)
	}
	if proton.Username != "shanghsin@proton.me" {
		t.Errorf("username = %q", proton.Username)
	}
	if proton.ClientUID != "e6lrnrncmszskq4cxc4nd4wekuko3oqt" {
		t.Errorf("client_uid = %q", proton.ClientUID)
	}
	if proton.ClientRefreshToken != "REFRESH_TOKEN_32" {
		t.Errorf("client_refresh_token = %q", proton.ClientRefreshToken)
	}
	if proton.ClientSaltedKeyPass != "SALTED_KEY_44" {
		t.Errorf("client_salted_key_pass = %q", proton.ClientSaltedKeyPass)
	}
}

// sqlNullString 构造有效的 sql.NullString。
func sqlNullString(s string) sql.NullString {
	return sql.NullString{String: s, Valid: s != ""}
}
