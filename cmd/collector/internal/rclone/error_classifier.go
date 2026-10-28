package rclone

import (
	"regexp"
	"strings"
)

// ErrorCode 表示归一化后的网盘/rclone错误代码。
type ErrorCode string

const (
	CodeDriveAuthInvalid       ErrorCode = "DRIVE_AUTH_INVALID"
	CodeDriveConfigInvalid     ErrorCode = "DRIVE_CONFIG_INVALID"
	CodeDriveRemoteNotFound    ErrorCode = "DRIVE_REMOTE_NOT_FOUND"
	CodeDriveQuotaExceeded      ErrorCode = "DRIVE_QUOTA_EXCEEDED"
	CodeDrivePermissionDenied  ErrorCode = "DRIVE_PERMISSION_DENIED"
	CodeRcloneTransient        ErrorCode = "RCLONE_TRANSIENT"
	CodeUnknown                ErrorCode = "UNKNOWN"
)

// Classification 包含错误分析结果。
type Classification struct {
	Code          ErrorCode
	Retryable     bool // 系统是否可自动重试
	UserRetryable bool // 用户是否可手动点击重试
	UserMessage   string
}

var (
	transientErrorPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)^TIMEOUT$`),
		regexp.MustCompile(`(?i)temporary failure`),
		regexp.MustCompile(`(?i)connection (reset|refused|aborted|closed)`),
		regexp.MustCompile(`(?i)i/o timeout`),
		regexp.MustCompile(`(?i)rclone [\s\S]* timed out`),
		regexp.MustCompile(`(?i)rclone [\s\S]* exited with code null`),
		regexp.MustCompile(`(?i)rclone [\s\S]* terminated by signal`),
		regexp.MustCompile(`(?i)rclone [\s\S]* exited without an exit code`),
		regexp.MustCompile(`(?i)TLS handshake timeout`),
		regexp.MustCompile(`(?i)timeout awaiting response headers`),
		regexp.MustCompile(`(?i)server closed idle connection`),
		regexp.MustCompile(`(?i)unexpected EOF`),
		regexp.MustCompile(`(?i)EOF while (reading|waiting|connecting)`),
		regexp.MustCompile(`(?i)\b5\d\d (?:Bad Gateway|Service Unavailable|Gateway Time-?out|Internal Server Error)\b`),
		regexp.MustCompile(`(?i)\(\s*Code=-?\d+,\s*Status=5\d\d\s*\)`),
	}

	authErrorPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)couldn'?t login`),
		regexp.MustCompile(`(?i)authentication failed`),
		regexp.MustCompile(`(?i)invalid (?:login|credentials|username|password)`),
		regexp.MustCompile(`(?i)invalid (?:access|refresh)?\s*token`),
		regexp.MustCompile(`(?i)bad password`),
		regexp.MustCompile(`(?i)login failed`),
		regexp.MustCompile(`(?i)unauthorized`),
		regexp.MustCompile(`(?i)invalid[_ -]?grant`),
		regexp.MustCompile(`(?i)token (?:expired|invalid|revoked)`),
		regexp.MustCompile(`(?i)auth/v\d+/refresh`),
		regexp.MustCompile(`(?i)Code=10013`),
		regexp.MustCompile(`(?i)requires a 2FA code`),
	}

	quotaErrorPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)quota exceeded`),
		regexp.MustCompile(`(?i)over quota`),
		regexp.MustCompile(`(?i)insufficient (?:storage|space)`),
		regexp.MustCompile(`(?i)not enough (?:storage|space)`),
		regexp.MustCompile(`(?i)storage .*full`),
		regexp.MustCompile(`(?i)disk full`),
	}

	permissionErrorPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)permission denied`),
		regexp.MustCompile(`(?i)access denied`),
		regexp.MustCompile(`(?i)forbidden`),
		regexp.MustCompile(`(?i)\b403\b`),
	}

	megaLoginObjectNotFound = regexp.MustCompile(`(?i)couldn'?t login[\s\S]*Object \(typically, node or user\) not found`)
	remoteNotFoundPatterns  = []*regexp.Regexp{
		regexp.MustCompile(`(?i)Object \(typically, node or user\) not found`),
		regexp.MustCompile(`(?i)directory not found`),
		regexp.MustCompile(`(?i)object not found`),
		regexp.MustCompile(`(?i)node not found`),
	}

	configInvalidPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)missing required drive config`),
		regexp.MustCompile(`(?i)missing required .* config`),
		regexp.MustCompile(`(?i)invalid drive config`),
	}

	transientJSONStartupError = regexp.MustCompile(`(?i)unexpected end of JSON input`)
	transientJSONContext      = regexp.MustCompile(`(?i)(failed to create file system|couldn'?t login|remote API|server response|mega)`)
)

func hasAnyPatternMatch(text string, patterns []*regexp.Regexp) bool {
	for _, p := range patterns {
		if p.MatchString(text) {
			return true
		}
	}
	return false
}

func hasMegaRemotePath(text string) bool {
	idx := strings.Index(strings.ToLower(text), ":mega,")
	if idx == -1 {
		return false
	}
	rest := text[idx+6:]
	nextColon := strings.Index(rest, ":")
	if nextColon == -1 || nextColon+1 >= len(rest) {
		return false
	}
	afterColon := rest[nextColon+1:]
	if len(afterColon) == 0 {
		return false
	}
	firstChar := afterColon[0]
	return firstChar != '"' && firstChar != '\\' && firstChar != ' ' && firstChar != '\t' && firstChar != '\n' && firstChar != '\r'
}

// IsProtonRefreshTokenDead 检查是否为 Proton 刷新令牌失效的狭窄信号。
func IsProtonRefreshTokenDead(errorText string) bool {
	t := strings.TrimSpace(errorText)
	if t == "" {
		return false
	}
	return strings.Contains(strings.ToLower(t), "code=10013") ||
		regexp.MustCompile(`(?i)invalid\s+refresh\s+token`).MatchString(t)
}

// UserErrorMessage 给出错误代码对应的友好提示文案。
func UserErrorMessage(code ErrorCode) string {
	switch code {
	case CodeDriveAuthInvalid:
		return "当前绑定的网盘无法登录。请重新绑定网盘后再重试。"
	case CodeDriveConfigInvalid:
		return "当前网盘绑定配置不完整。请重新绑定网盘后再重试。"
	case CodeDriveRemoteNotFound:
		return "目标网盘保存目录或远端节点不可用。请检查保存目录，或重新选择/重置保存目录后再重试。"
	case CodeDriveQuotaExceeded:
		return "目标网盘空间不足。请清理空间或更换保存目录后再重试。"
	case CodeDrivePermissionDenied:
		return "目标网盘拒绝写入。请检查绑定账号权限或保存目录后再重试。"
	case CodeRcloneTransient:
		return "网盘连接暂时异常，系统已自动重试但仍失败。请稍后再试。"
	default:
		return ""
	}
}

// ClassifyOptions 是错误分类时的上下文参数。
type ClassifyOptions struct {
	RemotePathScoped bool
}

// ClassifyError 根据 rclone 错误输出分类，返回机器可读代码与人性化文案。
func ClassifyError(errorText string, opts ...ClassifyOptions) Classification {
	text := strings.TrimSpace(errorText)
	if text == "" {
		return Classification{
			Code:          CodeUnknown,
			Retryable:     false,
			UserRetryable: true,
			UserMessage:   "",
		}
	}

	var opt ClassifyOptions
	if len(opts) > 0 {
		opt = opts[0]
	}

	if megaLoginObjectNotFound.MatchString(text) {
		remotePathScoped := opt.RemotePathScoped || hasMegaRemotePath(text)
		code := CodeDriveAuthInvalid
		if remotePathScoped {
			code = CodeDriveRemoteNotFound
		}
		return Classification{
			Code:          code,
			Retryable:     false,
			UserRetryable: remotePathScoped,
			UserMessage:   UserErrorMessage(code),
		}
	}

	if hasAnyPatternMatch(text, configInvalidPatterns) {
		return Classification{
			Code:          CodeDriveConfigInvalid,
			Retryable:     false,
			UserRetryable: true,
			UserMessage:   UserErrorMessage(CodeDriveConfigInvalid),
		}
	}

	if hasAnyPatternMatch(text, remoteNotFoundPatterns) {
		return Classification{
			Code:          CodeDriveRemoteNotFound,
			Retryable:     false,
			UserRetryable: true,
			UserMessage:   UserErrorMessage(CodeDriveRemoteNotFound),
		}
	}

	if transientJSONStartupError.MatchString(text) && transientJSONContext.MatchString(text) {
		return Classification{
			Code:          CodeRcloneTransient,
			Retryable:     true,
			UserRetryable: true,
			UserMessage:   UserErrorMessage(CodeRcloneTransient),
		}
	}

	if hasAnyPatternMatch(text, authErrorPatterns) {
		return Classification{
			Code:          CodeDriveAuthInvalid,
			Retryable:     false,
			UserRetryable: false,
			UserMessage:   UserErrorMessage(CodeDriveAuthInvalid),
		}
	}

	if hasAnyPatternMatch(text, quotaErrorPatterns) {
		return Classification{
			Code:          CodeDriveQuotaExceeded,
			Retryable:     false,
			UserRetryable: true,
			UserMessage:   UserErrorMessage(CodeDriveQuotaExceeded),
		}
	}

	if hasAnyPatternMatch(text, permissionErrorPatterns) {
		return Classification{
			Code:          CodeDrivePermissionDenied,
			Retryable:     false,
			UserRetryable: false,
			UserMessage:   UserErrorMessage(CodeDrivePermissionDenied),
		}
	}

	if hasAnyPatternMatch(text, transientErrorPatterns) {
		return Classification{
			Code:          CodeRcloneTransient,
			Retryable:     true,
			UserRetryable: true,
			UserMessage:   UserErrorMessage(CodeRcloneTransient),
		}
	}

	return Classification{
		Code:          CodeUnknown,
		Retryable:     false,
		UserRetryable: true,
		UserMessage:   "",
	}
}
