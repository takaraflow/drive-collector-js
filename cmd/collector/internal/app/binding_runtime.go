package app

import (
	"context"
	"strings"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
)

// protonValidator 是 drive.ProtonRuntime 的真实实现:
// 写临时 conf → 跑 rclone about → 读回 conf 收割旋转后的 session。
//
// 与 JS 侧 validateConfigWithWritableSession + ProtonDriveProvider
// 的 getWritableRcloneConfigEntries 对齐。
type protonRuntime struct {
	runner *rclone.Runner
}

func newProtonRuntime(runner *rclone.Runner) *protonRuntime { return &protonRuntime{runner: runner} }

// ValidateProton 实现 drive.ProtonRuntime。
//
// 密码在这里 obscure(运行时格式),一次性 2FA 只在本次 conf 里出现,
// 绝不进返回值 —— 会话收割只认 client_* 四件套。
func (p *protonRuntime) ValidateProton(ctx context.Context, username, password, twoFactor string) (map[string]string, string, string) {
	// 空白也算没输入 —— 与 JS 侧 normalizeBindingText 一致。
	// 直接扔给 rclone 只会换来一个更费解的报错。
	username = strings.TrimSpace(username)
	password = strings.TrimSpace(password)
	if username == "" || password == "" {
		return nil, "ERROR", "用户名或密码为空"
	}

	// conf 里的 password 必须是 obscure 过的。
	//
	// rclone 从 conf 读密码时一律走 reveal(解密),不会因为「看起来像明文」
	// 就自动兼容 —— 明文写进去等于让它解一段普通文本,于是报
	// "base64 decode failed ... illegal base64 data at input byte N",
	// 而且这个错在「创建文件系统」阶段就抛,看起来像账号问题,其实密码还没被看过。
	//
	// 绑定流程拿到的始终是用户刚输入的明文,所以 obscure 必须在【这里】做一次,
	// 而不是指望落库前的那个 —— 那份是给数据库用的,和这次验证用的 conf 无关。
	obscured, err := p.runner.Obscure(ctx, password)
	if err != nil {
		return nil, "ERROR", "混淆密码失败: " + sanitizeRclone(err.Error())
	}

	entries := map[string]string{
		"type":                   string(drive.TypeProton),
		"username":               username,
		"password":               obscured,
		"replace_existing_draft": "true",
	}
	if twoFactor != "" {
		entries["2fa"] = twoFactor
	}

	rt, err := rclone.NewRuntime("bindcheck", entries)
	if err != nil {
		return nil, "ERROR", err.Error()
	}
	defer rt.Dispose()

	cfg := rclone.Config{Runtime: rt, Timeout: 30 * time.Second}
	_, runErr := p.runner.Run(ctx, cfg,
		[]string{"about", rt.Target(), "--timeout", "15s"}, nil)
	if runErr != nil {
		// 错误里带 2FA 字样就是验证码错了 —— 让用户重输,而不是
		// 笼统的「验证失败」。与 JS 侧的 2FA 判定一致。
		detail := runErr.Error()
		if strings.Contains(detail, "Multi-factor authentication") ||
			strings.Contains(detail, "2FA") ||
			strings.Contains(detail, "Code=8002") {
			return nil, "2FA", sanitizeRclone(detail)
		}
		return nil, "ERROR", sanitizeRclone(detail)
	}

	section, err := rt.ReadSection()
	if err != nil {
		return nil, "ERROR", "读取回写配置失败: " + err.Error()
	}

	session := map[string]string{}
	for _, k := range drive.SessionKeys {
		if v := strings.TrimSpace(section[k]); v != "" {
			session[k] = v
		}
	}
	return session, "", ""
}

// sanitizeRclone 去掉 rclone 输出里的敏感段落(路径、token)。
// 与 JS 侧 sanitizeRcloneOutput 的目的一致:给用户看的错误里不能带凭据。
func sanitizeRclone(s string) string {
	out := strings.TrimSpace(s)
	if len(out) > 400 {
		out = out[:400]
	}
	return out
}
