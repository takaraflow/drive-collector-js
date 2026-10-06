package drive

import (
	"context"
	"fmt"
	"regexp"
	"strings"

	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
)

// 本文件是绑定向导的状态机 —— 与 JS 侧 DriveProviderFactory +
// MegaProvider + ProtonDriveProvider 对齐。
//
// 只搬了 Go 侧已实现两类网盘(Mega/Proton)的流程。JS 还有 8 个
// provider,它们的用户仍走 Node 服务,这里不碰。
//
// 会话存 bindingsession(Redis,key 与 JS 一致);文案内联在 handlers
// 里 —— 抽成 locales 结构是给 10 个 provider 做的事,两个用不上。

// ---------- 通用输入归一化(对应 src/domain/binding-input.js) ----------

var boolTrue = map[string]bool{
	"1": true, "true": true, "yes": true, "y": true, "on": true,
	"是": true, "有": true, "开启": true, "开": true,
}

var boolFalse = map[string]bool{
	"0": true, "false": true, "no": true, "n": true, "off": true,
	"否": true, "无": true, "关闭": true, "关": true,
}

// cancelKeywords 与 JS 侧 CANCEL_KEYWORDS 一致。
var cancelKeywords = map[string]bool{
	"/cancel": true, "cancel": true, "/取消": true, "取消": true,
}

func normalizeText(s string) string { return strings.TrimSpace(s) }

// obscureFn 是「明文密码 → rclone obscure」的可注入实现。
// 真实实现(worker 启动时)由 SetObscureRunner 装配,测试注入假的。
var obscureFn func(ctx context.Context, password string) (string, error)

// SetObscureRunner 注入 rclone 执行器。worker 启动时调用一次;
// 测试传 nil(配 TestMain 自己注入 obscureFn)。
func SetObscureRunner(r *rclone.Runner) {
	obscureRunner = r
	if r != nil {
		obscureFn = r.Obscure
	}
}

// obscureRunner 是 obscure 用的 rclone 执行器,由调用方注入。
// 包级变量而不是参数:两个 handler 的签名已经够长,而它全进程只需一个。
var obscureRunner *rclone.Runner

// obscureWithRunner 混淆明文密码。
//
// 与 JS 侧 CloudTool._obscureRequired 对应。密码【明文】只存在于绑定
// 会话的短暂窗口里,落库前必须 obscure —— 库里其他消费方
// (ToConnectionString 等)都假设拿到的是已混淆格式。
func obscureWithRunner(ctx context.Context, password string) (string, error) {
	if password == "" {
		return "", fmt.Errorf("drive: 空密码不需要 obscure")
	}
	if obscureFn == nil {
		return "", fmt.Errorf("drive: obscure runner 未注入(启动时须调 SetObscureRunner)")
	}
	return obscureFn(ctx, password)
}

func parseBool(s string) (value, ok bool) {
	switch strings.ToLower(normalizeText(s)) {
	case "1", "true", "yes", "y", "on", "是", "有", "开启", "开":
		return true, true
	case "0", "false", "no", "n", "off", "否", "无", "关闭", "关":
		return false, true
	}
	return false, false
}

// ---------- 结果类型 ----------

// BindResult 是一步输入的处理结果。
//
// NextStep 为空 = 流程结束(成功或最终失败);非空 = 前进到下一步。
type BindResult struct {
	// Success 报告这一步的输入是否通过。
	Success bool
	// Message 是给用户看的提示(下一问 / 错误 / 成功)。
	Message string
	// NextStep 为空表示终态。
	NextStep string
	// Failed 是「最终失败,该清会话」—— 只有最后一步验证不过才置位。
	// 中间步骤输入错只回一句提示,流程继续。
	Failed bool
	// FailureReason 是最终失败的结构化原因(2FA / ERROR / SESSION_BOOTSTRAP_FAILED)。
	FailureReason string
	// Data 是要合并进会话的数据。成功建盘时是最终凭据配置。
	Data map[string]string
	// Config 是成功建盘时的最终配置(密码已 obscure)。
	Config *DriveConfig
	// DriveName 是要写进 drives.name 的显示名(如 "Mega-xxx@x.com")。
	DriveName string
}

// Cancelled 报告该输入是否为取消指令。
func Cancelled(input string) bool { return cancelKeywords[strings.ToLower(normalizeText(input))] }

// ---------- 步骤常量(与 JS 步骤名逐字一致,会话里存的就是它们) ----------

const (
	MegaStepEmail   = "WAIT_EMAIL"
	MegaStepPass    = "WAIT_PASS"
	ProtonStepUser  = "WAIT_USERNAME"
	ProtonStepPass  = "WAIT_PASSWORD"
	ProtonStepUse2F = "WAIT_USE_2FA"
	ProtonStep2FA   = "WAIT_2FA"
)

// FirstStep 返回某网盘绑定的第一步。
func FirstStep(t Type) string {
	switch t {
	case TypeMega:
		return MegaStepEmail
	case TypeProton:
		return ProtonStepUser
	}
	return ""
}

// ---------- Mega ----------

var emailRe = regexp.MustCompile(`@`)

// HandleMegaStep 处理 Mega 绑定的一步输入。
//
// data 是会话里累积的数据(原始明文凭据,存 Redis/内存,不入库)。
func HandleMegaStep(ctx context.Context, runner *rclone.Runner, step, input string, data map[string]string) BindResult {
	if Cancelled(input) {
		return BindResult{Success: true, Message: "🚫 绑定流程已取消。"}
	}

	switch step {
	case MegaStepEmail:
		email := normalizeText(input)
		if !emailRe.MatchString(email) {
			return BindResult{Success: false, Message: "❌ 邮箱格式看似不正确，请重新输入："}
		}
		return BindResult{Success: true, Message: "🔑 <b>请输入密码</b>", NextStep: MegaStepPass,
			Data: map[string]string{"user": email}}

	case MegaStepPass:
		pass := normalizeText(input)
		if pass == "" {
			return BindResult{Success: false, Message: "🔑 <b>请输入密码</b>"}
		}
		// 最后一步:验证 → 建 config。失败是终态(清会话)。
		passObscured, err := runner.Obscure(ctx, pass)
		if err != nil {
			return BindResult{Success: false, Failed: true, FailureReason: "ERROR",
				Message: "❌ <b>绑定失败</b>\n\n原因：混淆密码时出错，请稍后重试。"}
		}
		cfg := DriveConfig{
			User: data["user"], Pass: passObscured,
			PassFormat: "rclone_obscured", SchemaVersion: 1, CredentialVerified: true,
		}
		// 真正的 rclone 验证在调用方(app 层)做 —— 这里只负责组装。
		return BindResult{
			Success:   true,
			Message:   "✅ <b>绑定成功！</b>\n\n账号: <code>" + data["user"] + "</code>\n\n现在可以直接发送文件或链接开始转存。",
			Data:      map[string]string{},
			Config:    &cfg,
			DriveName: "Mega-" + data["user"],
		}

	default:
		return BindResult{Success: false, Failed: true, Message: "未知步骤"}
	}
}

// ---------- Proton ----------

var code2FARe = regexp.MustCompile(`^\d{6}$`)

// ProtonRuntime 抽象「验证 Proton 配置 + 收割 session」。
//
// 真实实现跑 rclone(可写 conf + ReadSection 收割 session),测试注入假的。
// 与 JS 侧 validateConfigWithWritableSession 对应。
type ProtonRuntime interface {
	// ValidateProton 用明文凭据(+可选一次性 2FA)发起登录。
	// 返回收割到的 session 四件套(没有就是空 map)和错误原因。
	// reason 为 "2FA" / "ERROR" / "SESSION_BOOTSTRAP_FAILED" / ""(成功)。
	ValidateProton(ctx context.Context, username, password, twoFactor string) (session map[string]string, reason, details string)
}

// HandleProtonStep 处理 Proton 绑定的一步输入。
//
// 流程(与 JS ProtonDriveProvider 一致):
//
//	WAIT_USERNAME → WAIT_PASSWORD → WAIT_USE_2FA ┬─ no  ──→ 提交验证
//	                                             └─ yes ──→ WAIT_2FA → 提交验证
func HandleProtonStep(ctx context.Context, rt ProtonRuntime, step, input string, data map[string]string) BindResult {
	if Cancelled(input) {
		return BindResult{Success: true, Message: "🚫 绑定流程已取消。"}
	}

	switch step {
	case ProtonStepUser:
		username := normalizeText(input)
		if username == "" {
			return BindResult{Success: false, Message: "❌ 用户名不能为空，请重新输入。"}
		}
		return BindResult{Success: true,
			Message:  "🔑 <b>请输入 Proton 登录密码</b>",
			NextStep: ProtonStepPass,
			Data:     map[string]string{"username": username}}

	case ProtonStepPass:
		pass := normalizeText(input)
		if pass == "" {
			return BindResult{Success: false, Message: "❌ 密码不能为空，请重新输入。"}
		}
		return BindResult{Success: true,
			Message:  "🛡️ <b>这个账号是否开启了两步验证（2FA）？</b>\n\n请点下方按钮，或输入 <code>yes</code> / <code>no</code>。",
			NextStep: ProtonStepUse2F,
			Data:     map[string]string{"password": pass}}

	case ProtonStepUse2F:
		v, ok := parseBool(input)
		if !ok {
			return BindResult{Success: false, Message: "❌ 请选择是否开启 2FA，或输入 yes / no。"}
		}
		if !v {
			// 没有 2FA:直接提交验证。验证是终态步骤。
			return finalizeProton(ctx, rt, data, "")
		}
		return BindResult{Success: true,
			Message:  "🔢 <b>请输入当前 6 位 2FA 验证码</b>\n\n打开 Authenticator / Proton 验证器，输入当前动态码。\n验证码大约 30 秒刷新一次，请尽快提交。",
			NextStep: ProtonStep2FA,
			Data:     map[string]string{"two_factor_enabled": "true"}}

	case ProtonStep2FA:
		code := normalizeText(input)
		if !code2FARe.MatchString(code) {
			// 格式不对不算终态失败 —— 会话保留,用户重输。
			return BindResult{Success: false, Message: "❌ 2FA 验证码格式不正确，请输入 6 位数字。"}
		}
		return finalizeProton(ctx, rt, data, code)

	default:
		return BindResult{Success: false, Failed: true, Message: "未知步骤"}
	}
}

// finalizeProton 组装凭据、验证、收割 session。两个提交终点共用。
func finalizeProton(ctx context.Context, rt ProtonRuntime, data map[string]string, twoFactor string) BindResult {
	username, password := data["username"], data["password"]
	if username == "" || password == "" {
		return BindResult{Success: false, Failed: true, Message: "❌ <b>绑定失败</b>"}
	}
	if data["two_factor_enabled"] == "true" && twoFactor == "" {
		return BindResult{Success: false, Failed: true, Message: "❌ 当前账号已开启 2FA，请输入当前 6 位验证码。"}
	}

	session, reason, details := rt.ValidateProton(ctx, username, password, twoFactor)
	if reason != "" {
		msg := protonFailMessage(reason, details)
		return BindResult{Success: false, Failed: true, FailureReason: reason, Message: msg}
	}

	// 2FA 账号必须拿到可续期 session —— 不然下次转存还得一次性验证码,
	// 而那个早已过期,表现为「绑定了但转不动」。
	if data["two_factor_enabled"] == "true" && !protonSessionComplete(session) {
		return BindResult{Success: false, Failed: true, FailureReason: "SESSION_BOOTSTRAP_FAILED",
			Message: "⚠️ <b>登录成功，但未能保存长期会话</b>\n\n为避免后续转存再次要求 2FA，请重试绑定。\n若持续失败，请换用其他网盘。"}
	}

	// 持久化格式与 JS prepareConfigForStorage 一致:
	// 密码 obscure;一次性验证码【绝不入库】(30 秒就过期)。
	passObscured, err := obscureWithRunner(ctx, password)
	if err != nil {
		return BindResult{Success: false, Failed: true, FailureReason: "ERROR",
			Message: "❌ <b>绑定失败</b>\n\n原因：混淆密码时出错，请稍后重试。"}
	}
	cfg := DriveConfig{
		Username:           username,
		Password:           passObscured,
		PassFormat:         "rclone_obscured",
		SchemaVersion:      1,
		CredentialVerified: true,
		TwoFactorEnabled:   data["two_factor_enabled"] == "true",
	}
	for k, v := range session {
		switch k {
		case "client_uid":
			cfg.ClientUID = v
		case "client_access_token":
			cfg.ClientAccessToken = v
		case "client_refresh_token":
			cfg.ClientRefreshToken = v
		case "client_salted_key_pass":
			cfg.ClientSaltedKeyPass = v
		}
	}

	msg := "✅ <b>Proton Drive 绑定成功！</b>\n\n账号: <code>" + username + "</code>\n\n"
	if protonSessionComplete(session) {
		msg += "登录会话已保存，后续转存不需要再输入 2FA 验证码。\n"
	} else {
		msg += "当前账号无需 2FA。若后续登录异常，请重新绑定。\n"
	}
	msg += "现在可以直接发送文件或链接开始转存。"

	return BindResult{
		Success:   true,
		Data:      map[string]string{},
		Config:    &cfg,
		DriveName: "Protondrive-" + username,
		Message:   msg,
	}
}

func protonSessionComplete(session map[string]string) bool {
	for _, k := range SessionKeys {
		if strings.TrimSpace(session[k]) == "" {
			return false
		}
	}
	return len(SessionKeys) > 0
}

func protonFailMessage(reason, details string) string {
	switch reason {
	case "2FA":
		return "⚠️ <b>需要有效的 2FA 验证码</b>\n\n请重新绑定，并输入当前 6 位动态验证码。\n绑定成功后系统会保存登录会话，后续转存不再使用这次验证码。\n如果验证码已过期，打开验证器刷新后再试。"
	case "SESSION_BOOTSTRAP_FAILED":
		return "⚠️ <b>登录成功，但未能保存长期会话</b>\n\n为避免后续转存再次要求 2FA，请重试绑定。\n若持续失败，请换用其他网盘。"
	}
	if details != "" {
		return "⚠️ <b>Proton Drive 登录或配置验证失败</b>\n\n请检查用户名、密码，以及 2FA 验证码是否正确。\n" + details
	}
	return "⚠️ <b>Proton Drive 登录或配置验证失败</b>\n\n请检查用户名、密码，以及 2FA 验证码是否正确。"
}
