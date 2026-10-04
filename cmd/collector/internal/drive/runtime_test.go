package drive

import (
	"testing"
)

func protonDrive(cfg DriveConfig) *Drive {
	return &Drive{ID: "d1", UserID: "7428626313", Type: "protondrive", Config: cfg}
}

// TestWritableRuntimeOnlyForProton 只有需要回读 session 的网盘才走临时 conf。
//
// Mega 是静态凭据,用连接串就够 —— 多写一个临时文件、多一次磁盘 IO
// 都是没必要。判断错了会让 Mega 也走 conf 路径,而那条路径没有
// harvest,等于白绕一圈。
func TestWritableRuntimeOnlyForProton(t *testing.T) {
	if !protonDrive(DriveConfig{}).WritableRuntime() {
		t.Error("proton 必须走可写 runtime")
	}
	if (&Drive{Type: "mega"}).WritableRuntime() {
		t.Error("mega 不该走可写 runtime")
	}
	if (*Drive)(nil).WritableRuntime() {
		t.Error("nil 不该 panic")
	}
}

// TestRuntimeEntriesPrefersSession session 齐全时【不发密码】。
//
// 这是记忆里 Code=10013 砖化的根源:每次用密码登录都会触发一次
// refresh_token 旋转,而旧 token 立即作废。有 session 就用 session,
// 少一次登录就少一次砖化机会。
func TestRuntimeEntriesPrefersSession(t *testing.T) {
	d := protonDrive(DriveConfig{
		Username:            "u@x.com",
		Password:            "obscured-pw",
		ClientUID:           "uid",
		ClientAccessToken:   "at",
		ClientRefreshToken:  "rt",
		ClientSaltedKeyPass: "skp",
	})

	name, entries, err := d.RuntimeEntries()
	if err != nil {
		t.Fatal(err)
	}
	if name != "u7428626313" {
		t.Errorf("段名 = %q", name)
	}
	if entries["client_refresh_token"] != "rt" {
		t.Error("session 没写进 conf")
	}
	if _, has := entries["password"]; has {
		t.Error("有 session 时不该发密码 —— 会多一次 refresh_token 旋转机会")
	}
	if entries["replace_existing_draft"] != "true" {
		t.Error("必须开 replace_existing_draft,否则重试会撞 'a draft exist'")
	}
}

// TestRuntimeEntriesFallsBackToPassword session 不完整时用密码。
//
// 四件套缺一个都不能当 session 用 —— rclone 会带着空 token 去认证,
// 报「认证失败」,完全看不出是缺字段。
func TestRuntimeEntriesFallsBackToPassword(t *testing.T) {
	d := protonDrive(DriveConfig{
		Username:           "u@x.com",
		Password:           "obscured-pw",
		ClientUID:          "uid",
		ClientAccessToken:  "at",
		ClientRefreshToken: "rt",
		// 缺 ClientSaltedKeyPass
	})

	_, entries, err := d.RuntimeEntries()
	if err != nil {
		t.Fatal(err)
	}
	if entries["password"] != "obscured-pw" {
		t.Error("session 不完整时应退回密码")
	}
	if _, has := entries["client_refresh_token"]; has {
		t.Error("不完整的 session 不该写进 conf")
	}
}

// TestRuntimeEntriesRejectsNoCredentials 什么都没有必须明确报错。
func TestRuntimeEntriesRejectsNoCredentials(t *testing.T) {
	if _, _, err := protonDrive(DriveConfig{}).RuntimeEntries(); err == nil {
		t.Error("无凭据应报错")
	}
}

// TestHarvestSessionDetectsRotation 收割必须能识别出 token 变了。
//
// 这是整个机制的目的:rclone 跑完把 refresh_token 换掉,旧的在服务端
// 立即作废。识别不出来 = 不写库 = 下次拿旧 token 认证 = Code=10013。
func TestHarvestSessionDetectsRotation(t *testing.T) {
	d := protonDrive(DriveConfig{
		ClientUID:           "uid",
		ClientAccessToken:   "at-OLD",
		ClientRefreshToken:  "rt-OLD",
		ClientSaltedKeyPass: "skp",
	})

	next, changed := d.HarvestSession(map[string]string{
		"client_uid":             "uid",
		"client_access_token":    "at-NEW",
		"client_refresh_token":   "rt-NEW",
		"client_salted_key_pass": "skp",
	})

	if !changed {
		t.Fatal("token 变了却没识别出来 —— 不写库的话下次上传必失败")
	}
	if next.ClientRefreshToken != "rt-NEW" || next.ClientAccessToken != "at-NEW" {
		t.Errorf("收割结果 = %+v", next)
	}
	if !next.CredentialVerified {
		t.Error("收割成功应标记凭据已验证")
	}
}

// TestHarvestSessionNoChangeSkipsWrite 没变就不写库。
//
// 少一次 D1 写,也少一次无谓的 updated_at 抖动 —— 那个字段被
// FindStalledTasks 用来判断僵尸任务,乱动会让它误判。
func TestHarvestSessionNoChangeSkipsWrite(t *testing.T) {
	cfg := DriveConfig{
		ClientUID:           "uid",
		ClientAccessToken:   "at",
		ClientRefreshToken:  "rt",
		ClientSaltedKeyPass: "skp",
	}
	d := protonDrive(cfg)

	_, changed := d.HarvestSession(map[string]string{
		"client_uid":             "uid",
		"client_access_token":    "at",
		"client_refresh_token":   "rt",
		"client_salted_key_pass": "skp",
	})
	if changed {
		t.Error("没变却报告 changed —— 会多写一次库")
	}
}

// TestHarvestSessionKeepsOldOnEmptySection conf 里没有的字段不能被清空。
//
// rclone 有时只写它改过的字段。把没出现的当成「空」会把好好的
// session 清掉 —— 那比不收割更糟。
func TestHarvestSessionKeepsOldOnEmptySection(t *testing.T) {
	d := protonDrive(DriveConfig{
		ClientUID:           "uid",
		ClientAccessToken:   "at",
		ClientRefreshToken:  "rt",
		ClientSaltedKeyPass: "skp",
	})

	next, changed := d.HarvestSession(map[string]string{})
	if changed {
		t.Error("空 section 不该报告 changed")
	}
	if next.ClientRefreshToken != "rt" {
		t.Errorf("旧值被清掉了:%+v", next)
	}
}

// TestRemoteNameMatchesNode 段名规则与 JS 侧一致。
func TestRemoteNameMatchesNode(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"7428626313", "u7428626313"},
		{"", "uanon"},
		{"a/b c", "uabc"},
		{"123456789012345678901234567890", "u123456789012345678901234"},
	} {
		if got := RemoteName(c.in); got != c.want {
			t.Errorf("RemoteName(%q) = %q,期望 %q", c.in, got, c.want)
		}
	}
}
