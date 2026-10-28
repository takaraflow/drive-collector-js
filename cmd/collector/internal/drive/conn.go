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
	TypeMega        Type = "mega"
	TypeProton      Type = "protondrive"
	TypeWebDAV      Type = "webdav"
	TypeOSS         Type = "oss"
	TypePikPak      Type = "pikpak"
	TypeFilen       Type = "filen"
	TypePCloud      Type = "pcloud"
)

// Supported 列出当前实现的网盘。
func Supported() []Type {
	return []Type{
		TypeMega, TypeProton, TypeWebDAV, TypeOSS, TypePikPak, TypeFilen, TypePCloud,
	}
}

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

	// WebDAV
	URL    string
	Vendor string

	// OSS / S3
	Endpoint string
	Bucket   string
	AK       string
	SK       string
	Provider string

	// Filen
	APIKey string
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
	case TypeWebDAV:
		return webdavConn(cfg)
	case TypeOSS:
		return ossConn(cfg)
	case TypePikPak:
		return pikpakConn(cfg)
	case TypeFilen:
		return filenConn(cfg)
	case TypePCloud:
		return pCloudConn(cfg)
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
		// 没有 session:回退到明文/已混淆密码。
		// 绑定完成后的首次调用走这里(第一次登录拿 session)。
		if cfg.Pass == "" {
			return "", fmt.Errorf("drive: protondrive 既无有效 session 又无密码")
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

func webdavConn(cfg Config) (string, error) {
	if cfg.URL == "" || cfg.User == "" || cfg.Pass == "" {
		return "", fmt.Errorf("drive: webdav 缺少 URL、用户名或密码")
	}
	vendor := cfg.Vendor
	if vendor == "" {
		vendor = "other"
	}
	return fmt.Sprintf(":%s,url=%q,user=%q,pass=%q,vendor=%q:",
		TypeWebDAV, escapeValue(cfg.URL), escapeValue(cfg.User), escapeValue(cfg.Pass), escapeValue(vendor)), nil
}

func ossConn(cfg Config) (string, error) {
	if cfg.Endpoint == "" || cfg.Bucket == "" || cfg.AK == "" || cfg.SK == "" {
		return "", fmt.Errorf("drive: oss 缺少 endpoint、bucket、AK 或 SK")
	}
	provider := cfg.Provider
	if provider == "" {
		provider = "Other"
	}
	return fmt.Sprintf(":s3,provider=%q,endpoint=%q,access_key_id=%q,secret_access_key=%q:%s",
		escapeValue(provider), escapeValue(cfg.Endpoint), escapeValue(cfg.AK), escapeValue(cfg.SK), cfg.Bucket), nil
}

func pikpakConn(c Config) (string, error) {
	if c.User == "" || c.Pass == "" {
		return "", fmt.Errorf("drive: pikpak 缺少用户名或密码")
	}
	parts := []string{
		fmt.Sprintf("user=%q", escapeValue(c.User)),
		fmt.Sprintf("pass=%q", escapeValue(c.Pass)),
	}
	return fmt.Sprintf(":pikpak,%s:", strings.Join(parts, ",")), nil
}

func filenConn(c Config) (string, error) {
	if c.User == "" || c.Pass == "" || c.APIKey == "" {
		return "", fmt.Errorf("drive: filen 缺少邮箱、密码或 API Key")
	}
	parts := []string{
		fmt.Sprintf("email=%q", escapeValue(c.User)),
		fmt.Sprintf("password=%q", escapeValue(c.Pass)),
		fmt.Sprintf("api_key=%q", escapeValue(c.APIKey)),
	}
	return fmt.Sprintf(":filen,%s:", strings.Join(parts, ",")), nil
}

func pCloudConn(c Config) (string, error) {
	if c.User == "" || c.Pass == "" {
		return "", fmt.Errorf("drive: pcloud 缺少账号或密码")
	}
	return fmt.Sprintf(`:webdav,url="https://webdav.pcloud.com",vendor="other",user=%q,pass=%q:`,
		escapeValue(c.User), escapeValue(c.Pass)), nil
}
