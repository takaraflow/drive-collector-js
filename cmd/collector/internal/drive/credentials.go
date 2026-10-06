package drive

import (
	"database/sql"
	"fmt"
	"strings"
)

// DriveConfig 是 drives 表里 config_data 的结构。
//
// **不是加密的** —— Node 侧 DriveRepository._parseConfigData 就是
// JSON.parse,明文存明文取。这点必须确认过:如果是加密的,Go 侧
// 解不开就会拼出错误的连接串,而且症状是「连不上」,极难定位。
type DriveConfig struct {
	// Mega
	User string `json:"user"`
	Pass string `json:"pass"`

	// Proton —— 与 ProtonSession 字段一一对应
	Username            string `json:"username"`
	Password            string `json:"password"`
	ClientUID           string `json:"client_uid"`
	ClientAccessToken   string `json:"client_access_token"`
	ClientRefreshToken  string `json:"client_refresh_token"`
	ClientSaltedKeyPass string `json:"client_salted_key_pass"`

	// PassFormat 标记密码是否已 rclone obscure。
	//
	// 关键:密码是 obscure 过的,【不解密】,原样传给 rclone ——
	// rclone 自己会反解。Go 侧若试图解码只会得到垃圾。
	PassFormat string `json:"pass_format"`

	// TwoFactorEnabled 是 Proton 绑定时用户报告的 2FA 状态。
	// 只用于「绑定成功但没拿到 session」的判断 —— 一次性验证码本身
	// 绝不入库(30 秒就过期,存了只会让后续转存撞 422)。
	TwoFactorEnabled bool `json:"two_factor_enabled"`

	// SchemaVersion 用于将来格式演进时分支处理。
	SchemaVersion int `json:"config_schema_version"`

	// CredentialVerified 表示凭据曾成功验证过。
	CredentialVerified bool `json:"credential_verified"`
}

// Drive 是 drives 表的一行。
type Drive struct {
	ID           string
	UserID       string
	Name         string
	Type         string
	Config       DriveConfig
	RemoteFolder sql.NullString
	Status       string
	IsDefault    int
}

// ToConnectionString 把网盘配置转成 rclone 连接串。
//
// 与 JS 侧 BaseDriveProvider.getConnectionString 对齐:
//   - 密码【原样】传,obscure 的由 rclone 自己解
//   - 反斜杠和引号必须转义,否则含这两个字符的密码会截断连接串
func ToConnectionString(d *Drive) (string, error) {
	if d == nil {
		return "", fmt.Errorf("drive: 网盘配置为空")
	}
	switch Type(d.Type) {
	case TypeMega:
		if d.Config.User == "" || d.Config.Pass == "" {
			return "", fmt.Errorf("drive: mega 凭据不完整(user=%q pass=%v)",
				d.Config.User, d.Config.Pass != "")
		}
		return ConnectionString(TypeMega, Config{
			User: d.Config.User,
			Pass: d.Config.Pass,
		})

	case TypeProton:
		// 有可复用 session 就用它 —— 不重新提交密码,也就不会触发
		// 一次性 refresh_token 的旋转(记忆里的 Code=10013 砖化)。
		sess := &ProtonSession{
			ClientUID:           d.Config.ClientUID,
			ClientAccessToken:   d.Config.ClientAccessToken,
			ClientRefreshToken:  d.Config.ClientRefreshToken,
			ClientSaltedKeyPass: d.Config.ClientSaltedKeyPass,
		}
		hasSession := sess.HasRefreshToken()

		user := d.Config.Username
		if user == "" {
			user = d.Config.User
		}
		pass := d.Config.Password
		if pass == "" {
			pass = d.Config.Pass
		}

		// session 四件套必须齐全。缺任何一个都不能发 —— rclone 会带着
		// 空 token 去认证,报「认证失败」,完全看不出是配置缺字段。
		// 这里【必须置 nil】,不能只是把 hasSession 改成 false:后者
		// 会让 ConnectionString 内部的 HasRefreshToken() 仍然判定为真。
		if hasSession && (sess.ClientAccessToken == "" ||
			sess.ClientSaltedKeyPass == "" || sess.ClientUID == "") {
			hasSession = false
		}
		if !hasSession {
			sess = nil
		}

		return ConnectionString(TypeProton, Config{
			User:    user,
			Pass:    pass,
			Session: sess,
		})
	}
	return "", fmt.Errorf("drive: %q 尚未实现(占位)", d.Type)
}

// RemotePath 返回该网盘上应使用的目标路径。
//
// 优先 drives.remote_folder(用户在 UI 里设的),退回全局 REMOTE_FOLDER。
// 少了这一步,文件会传到根目录而不是用户指定的目录。
func (d *Drive) RemotePath(globalRemoteFolder string) string {
	if d != nil && d.RemoteFolder.Valid && strings.TrimSpace(d.RemoteFolder.String) != "" {
		return d.RemoteFolder.String
	}
	return globalRemoteFolder
}
