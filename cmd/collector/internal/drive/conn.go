// Package drive 是网盘接入层。
//
// 按精简规格只实现两个已实测可用的:Mega 和 Proton。其余留占位,
// 用户选到时回「暂未支持」,不动现有 JS 实现。
//
// 为什么不抽象成通用框架:Mega 和 Proton 的绑定模型完全不同 ——
//
//	Mega   填邮箱 + 密码,两个字段
//	Proton 四步流程(username → password → 2FA?→ code)+ session 生命周期
//
// 强行统一成一个 "AbstractProvider" 就是历史上那套过度设计。
// 这里的抽象只到「拼 rclone 连接串」这一层,再往上各走各的。
package drive

import (
	"fmt"
	"strings"
)

// Type 是网盘类型。
type Type string

const (
	TypeMega   Type = "mega"
	TypeProton Type = "protondrive"
)

// Supported 列出当前实现的网盘。
func Supported() []Type { return []Type{TypeMega, TypeProton} }

// IsSupported 报告该类型是否已实现。
//
// 未实现的类型必须明确返回 false —— 边缘节点据此回「暂未支持」,
// 而不是让它落进一个拼不出连接串的分支,报一个看不懂的错误。
func IsSupported(t Type) bool {
	for _, s := range Supported() {
		if s == t {
			return true
		}
	}
	return false
}

// Config 是绑定的凭据集合。
type Config struct {
	// Mega
	User string
	Pass string

	// Proton —— 复用 User/Pass 作为 username/password,额外带 session。
	// session 存在时不必再提交密码(rclone 用它直接续期)。
	Session *ProtonSession

	// PassFormat 标记密码是否已经 rclone obscure 过。
	PassFormat string
}

// ProtonSession 是 Proton 的可复用会话。
//
// 关键:refresh_token 是**一次性**的 —— rclone 用掉它就会换成新的,
// 而旧的立即失效。并发两个任务同时用它,一个把 R1 转成 R2,
// 另一个手里的 R1 就死了 → Code=10013 → 账号永久砖化。
//
// 所以 Session 必须配合 drive.SessionLock 使用,见 manager.go。
type ProtonSession struct {
	ClientUID           string
	ClientAccessToken   string
	ClientRefreshToken  string
	ClientSaltedKeyPass string
}

// HasRefreshToken 报告是否有可续期的凭据。
func (s *ProtonSession) HasRefreshToken() bool {
	return s != nil && s.ClientRefreshToken != ""
}

// ConnectionString 拼出 rclone 连接串。
//
// 格式来自 JS 侧 BaseDriveProvider.getConnectionString:
//
//	:backend,key="value",key2="value2":
//
// 转义规则逐字照搬:反斜杠和双引号都要转义 —— 密码里出现
// 任何一个都会截断连接串,症状是「配置明明对却连不上」。
func ConnectionString(t Type, cfg Config) (string, error) {
	switch t {
	case TypeMega:
		return withUserPass(t, cfg)
	case TypeProton:
		return protonConn(cfg)
	default:
		return "", fmt.Errorf("drive: %q 尚未实现(占位,后续补)", t)
	}
}

func withUserPass(t Type, cfg Config) (string, error) {
	if cfg.User == "" || cfg.Pass == "" {
		return "", fmt.Errorf("drive: %s 缺少用户名或密码", t)
	}
	return fmt.Sprintf(":%s,user=%q,pass=%q:",
		t, escapeValue(cfg.User), escapeValue(cfg.Pass)), nil
}

func protonConn(cfg Config) (string, error) {
	if cfg.User == "" {
		return "", fmt.Errorf("drive: protondrive 缺少用户名")
	}

	segments := []string{
		fmt.Sprintf("username=%q", escapeValue(cfg.User)),
	}

	// 有可复用 session 就只用它 —— 不重新提交密码,也就不会触发
	// 那条「一次性 refresh_token」的竞态。
	if cfg.Session.HasRefreshToken() {
		segments = append(segments,
			fmt.Sprintf("client_uid=%q", escapeValue(cfg.Session.ClientUID)),
			fmt.Sprintf("client_access_token=%q", escapeValue(cfg.Session.ClientAccessToken)),
			fmt.Sprintf("client_refresh_token=%q", escapeValue(cfg.Session.ClientRefreshToken)),
			fmt.Sprintf("client_salted_key_pass=%q", escapeValue(cfg.Session.ClientSaltedKeyPass)),
		)
	} else {
		if cfg.Pass == "" {
			return "", fmt.Errorf("drive: protondrive 缺少密码或可复用 session")
		}
		segments = append(segments, fmt.Sprintf("password=%q", escapeValue(cfg.Pass)))
	}

	return ":" + string(TypeProton) + "," + strings.Join(segments, ",") + ":", nil
}

// escapeValue 与 JS 侧 _escapeValue 逐字对应。
//
// 顺序很关键:必须先转义反斜杠,再转义引号。反过来会让
// 引号产生的转义符自己再被转义一次,密码里带引号就必然出错。
func escapeValue(v string) string {
	v = strings.ReplaceAll(v, `\`, `\\`)
	v = strings.ReplaceAll(v, `"`, `\"`)
	return v
}
