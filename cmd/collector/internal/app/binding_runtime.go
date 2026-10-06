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
	entries := map[string]string{
		"type":                   string(drive.TypeProton),
		"username":               username,
		"password":               password,
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
