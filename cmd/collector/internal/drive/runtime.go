package drive

import (
	"fmt"
	"regexp"
	"strings"
)

// SessionKeys 是会随 rclone 运行而旋转的字段。
//
// 与 JS 侧 ProtonDriveProvider 的 SESSION_KEYS 逐字一致。
var SessionKeys = []string{
	"client_uid",
	"client_access_token",
	"client_refresh_token",
	"client_salted_key_pass",
}

var nonRemoteChars = regexp.MustCompile(`[^a-zA-Z0-9_-]`)

// RemoteName 生成 conf 里的段名。
//
// 与 JS 侧 `u${userId}` 的规则一致(清洗非法字符、截断 24 字符)。
// 段名本身不参与认证,但两边不一致会让排查时对不上号。
func RemoteName(userID string) string {
	cleaned := nonRemoteChars.ReplaceAllString(userID, "")
	if len(cleaned) > 24 {
		cleaned = cleaned[:24]
	}
	if cleaned == "" {
		cleaned = "anon"
	}
	return "u" + cleaned
}

// WritableRuntime 判断该网盘是否必须走临时 conf。
//
// 只有需要回读旋转 session 的网盘(true),别的用连接串就够 ——
// 多写一个临时文件、多一次磁盘 IO 都是没必要。与 JS 侧
// `typeof provider.getWritableRcloneConfigEntries === 'function'` 对应。
func (d *Drive) WritableRuntime() bool {
	return d != nil && Type(d.Type) == TypeProton
}

// RuntimeEntries 构造要写进临时 conf 的键值。
//
// 这是「各网盘自己的知识」,所以放在 drive 包而不是 rclone 包 ——
// rclone 层不该知道 protondrive 要哪些字段。
//
// 与 JS 侧 ProtonDriveProvider.getWritableRcloneConfigEntries 对应:
//   - session 齐全时只发 session,【不发密码】—— 少一次登录就少一次
//     一次性 refresh_token 的旋转机会(记忆里 Code=10013 砖化的根源)
//   - replace_existing_draft 必须开:中断的直传会在目标位置留下 Proton
//     draft,不开的话重试永远撞 "a draft exist"
func (d *Drive) RuntimeEntries() (remoteName string, entries map[string]string, err error) {
	if d == nil {
		return "", nil, fmt.Errorf("drive: 网盘配置为空")
	}
	if Type(d.Type) != TypeProton {
		return "", nil, fmt.Errorf("drive: %q 不需要可写配置", d.Type)
	}

	user := d.Config.Username
	if user == "" {
		user = d.Config.User
	}
	pass := d.Config.Password
	if pass == "" {
		pass = d.Config.Pass
	}

	entries = map[string]string{
		"type":                   string(TypeProton),
		"replace_existing_draft": "true",
	}

	sess := ProtonSession{
		ClientUID:           d.Config.ClientUID,
		ClientAccessToken:   d.Config.ClientAccessToken,
		ClientRefreshToken:  d.Config.ClientRefreshToken,
		ClientSaltedKeyPass: d.Config.ClientSaltedKeyPass,
	}

	if sess.Complete() {
		entries["client_uid"] = sess.ClientUID
		entries["client_access_token"] = sess.ClientAccessToken
		entries["client_refresh_token"] = sess.ClientRefreshToken
		entries["client_salted_key_pass"] = sess.ClientSaltedKeyPass
		return RemoteName(d.UserID), entries, nil
	}

	// 没有完整 session —— 用密码首次登录。
	// 注意 password 是 rclone obscure 过的,原样写进 conf,不要去解它。
	if user == "" || pass == "" {
		return "", nil, fmt.Errorf("drive: proton 缺凭据(session 不完整且 username/password 为空)")
	}
	entries["username"] = user
	entries["password"] = pass
	return RemoteName(d.UserID), entries, nil
}

// HarvestSession 从读回的 conf 里收割旋转后的 session。
//
// 返回 changed=false 表示 rclone 没换 token,不必写库 —— 少一次 D1 写。
//
// 【必须】在 rclone 跑完之后调用:Proton 的 refresh_token 是一次性的,
// rclone 跑完会把它换掉,旧 token 立即作废在服务端。不回写的话,
// 下一次拿旧 token 去认证就是 Code=10013 —— 而 rclone 那边不报错,
// 只是把这个网盘静默地变成用不了。
func (d *Drive) HarvestSession(section map[string]string) (DriveConfig, bool) {
	next := d.Config

	if cur := section["client_uid"]; cur != "" {
		next.ClientUID = cur
	}
	if cur := section["client_access_token"]; cur != "" {
		next.ClientAccessToken = cur
	}
	if cur := section["client_refresh_token"]; cur != "" {
		next.ClientRefreshToken = cur
	}
	if cur := section["client_salted_key_pass"]; cur != "" {
		next.ClientSaltedKeyPass = cur
	}

	changed := next.ClientUID != d.Config.ClientUID ||
		next.ClientAccessToken != d.Config.ClientAccessToken ||
		next.ClientRefreshToken != d.Config.ClientRefreshToken ||
		next.ClientSaltedKeyPass != d.Config.ClientSaltedKeyPass

	if changed {
		next.CredentialVerified = true
	}
	return next, changed
}

// Complete 判断 session 四件套是否齐全。
//
// 不齐就不能用:rclone 会带着空 token 去认证,报「认证失败」,
// 完全看不出是缺字段。宁可在这里明确拒绝。
func (s ProtonSession) Complete() bool {
	return strings.TrimSpace(s.ClientUID) != "" &&
		strings.TrimSpace(s.ClientAccessToken) != "" &&
		strings.TrimSpace(s.ClientRefreshToken) != "" &&
		strings.TrimSpace(s.ClientSaltedKeyPass) != ""
}
