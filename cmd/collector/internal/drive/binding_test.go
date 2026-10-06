package drive

import (
	"context"
	"os"
	"testing"
)

// fakeRunner 满足 HandleMegaStep 的签名要求(不真跑 rclone)。
//
// Mega 的中间步骤(邮箱)不触发 obscure,够测状态机;
// 终态要 obscure,由 Proton 侧的接口注入模式覆盖。

// fakeProtonRuntime 记录调用并回放预设结果。
type fakeProtonRuntime struct {
	session map[string]string
	reason  string
	got     map[string]string // 捕获到的提交参数
}

func (f *fakeProtonRuntime) ValidateProton(ctx context.Context, username, password, twoFactor string) (map[string]string, string, string) {
	f.got = map[string]string{"username": username, "password": password, "2fa": twoFactor}
	return f.session, f.reason, ""
}

var fullSession = map[string]string{
	"client_uid": "u", "client_access_token": "a",
	"client_refresh_token": "r", "client_salted_key_pass": "s",
}

func merge(dst, src map[string]string) {
	for k, v := range src {
		dst[k] = v
	}
}

func TestMegaEmailStep(t *testing.T) {
	ctx := context.Background()
	data := map[string]string{}

	r := HandleMegaStep(ctx, nil, MegaStepEmail, "not-an-email", data)
	if r.Success || r.NextStep != "" {
		t.Fatalf("坏邮箱应该被拒: %+v", r)
	}

	r = HandleMegaStep(ctx, nil, MegaStepEmail, " a@b.com ", data)
	if !r.Success || r.NextStep != MegaStepPass || r.Data["user"] != "a@b.com" {
		t.Fatalf("好邮箱应前进到密码步: %+v", r)
	}
}

func TestMegaCancel(t *testing.T) {
	r := HandleMegaStep(context.Background(), nil, MegaStepPass, "取消",
		map[string]string{"user": "a@b"})
	if !r.Success || r.NextStep != "" || r.Config != nil {
		t.Fatalf("取消应直接结束(不建盘): %+v", r)
	}
}

func TestProtonNo2FAPath(t *testing.T) {
	ctx := context.Background()
	rt := &fakeProtonRuntime{session: fullSession}
	data := map[string]string{}

	r := HandleProtonStep(ctx, rt, ProtonStepUser, "  user@proton.me  ", data)
	if !r.Success || r.NextStep != ProtonStepPass || r.Data["username"] != "user@proton.me" {
		t.Fatalf("用户名步骤: %+v", r)
	}
	merge(data, r.Data)

	r = HandleProtonStep(ctx, rt, ProtonStepPass, "pw", data)
	if !r.Success || r.NextStep != ProtonStepUse2F {
		t.Fatalf("密码步骤: %+v", r)
	}
	merge(data, r.Data)

	// 非法布尔:原地拒绝,不清会话、不前进。
	r = HandleProtonStep(ctx, rt, ProtonStepUse2F, "也许", data)
	if r.Success || r.Failed || r.NextStep != "" {
		t.Fatalf("非法布尔应被原地拒绝: %+v", r)
	}

	r = HandleProtonStep(ctx, rt, ProtonStepUse2F, "no", data)
	if !r.Success || r.NextStep != "" || r.Config == nil {
		t.Fatalf("no 2FA 应直接提交成功: %+v", r)
	}
	if rt.got["2fa"] != "" {
		t.Fatalf("不该提交 2FA: %v", rt.got)
	}
	if rt.got["username"] != "user@proton.me" || rt.got["password"] != "pw" {
		t.Fatalf("凭据应传给验证器: %v", rt.got)
	}
	if !r.Config.CredentialVerified {
		t.Fatal("成功路径应标记凭据已验证")
	}
}

func TestProton2FABranch(t *testing.T) {
	ctx := context.Background()
	rt := &fakeProtonRuntime{session: fullSession}
	data := map[string]string{"username": "u@x", "password": "p"}

	r := HandleProtonStep(ctx, rt, ProtonStepUse2F, "yes", data)
	if !r.Success || r.NextStep != ProtonStep2FA || r.Failed {
		t.Fatalf("yes 应前进到 2FA 步: %+v", r)
	}
	merge(data, r.Data)

	// 坏格式:可重输,不清会话。
	r = HandleProtonStep(ctx, rt, ProtonStep2FA, "12ab", data)
	if r.Success || r.Failed || r.NextStep != "" {
		t.Fatalf("坏验证码应可重输: %+v", r)
	}

	r = HandleProtonStep(ctx, rt, ProtonStep2FA, "123456", data)
	if !r.Success || r.Config == nil {
		t.Fatalf("2FA 提交应成功: %+v", r)
	}
	if rt.got["2fa"] != "123456" {
		t.Fatalf("验证码应传给验证器: %v", rt.got)
	}
	if r.Config.ClientRefreshToken != "r" {
		t.Fatalf("session 应进 config: %+v", r.Config)
	}
}

func TestProton2FARequiresDurableSession(t *testing.T) {
	// 走真实路径:yes → WAIT_2FA → 提交验证码 → 登录成功但没收割到
	// session → 必须判失败。不然 2FA 账号下次转存只有一条早已过期的
	// 一次性码,必死。
	rt := &fakeProtonRuntime{session: map[string]string{}}
	data := map[string]string{"username": "u", "password": "p"}

	r := HandleProtonStep(context.Background(), rt, ProtonStepUse2F, "yes", data)
	if !r.Success || r.NextStep != ProtonStep2FA {
		t.Fatalf("yes 应前进: %+v", r)
	}
	merge(data, r.Data)

	r = HandleProtonStep(context.Background(), rt, ProtonStep2FA, "123456", data)
	if r.Success || r.FailureReason != "SESSION_BOOTSTRAP_FAILED" || !r.Failed {
		t.Fatalf("2FA 无 session 应终态失败: %+v", r)
	}
}

func TestProton2FAEnabledButAnsweredNo(t *testing.T) {
	// 会话里标记了 2FA,用户却答 no —— 自相矛盾,应拒绝而不是
	// 带着空验证码去登录(必撞 2FA 错误)。
	rt := &fakeProtonRuntime{session: fullSession}
	r := HandleProtonStep(context.Background(), rt, ProtonStepUse2F, "no",
		map[string]string{"username": "u", "password": "p", "two_factor_enabled": "true"})
	if r.Success || !r.Failed {
		t.Fatalf("标记 2FA 却答 no 应失败: %+v", r)
	}
}

func TestProton2FAFailureReason(t *testing.T) {
	rt := &fakeProtonRuntime{reason: "2FA", session: fullSession}
	r := HandleProtonStep(context.Background(), rt, ProtonStepUse2F, "no",
		map[string]string{"username": "u", "password": "p"})
	if r.Success || r.FailureReason != "2FA" || !r.Failed {
		t.Fatalf("2FA 原因应透传: %+v", r)
	}
}

func TestProtonSessionCompleteHelper(t *testing.T) {
	if protonSessionComplete(map[string]string{"client_uid": "u"}) {
		t.Fatal("缺字段不该算完整")
	}
	if !protonSessionComplete(fullSession) {
		t.Fatal("四件套齐全应该通过")
	}
	if protonSessionComplete(map[string]string{}) && len(SessionKeys) > 0 {
		t.Fatal("空 session 不该算完整")
	}
}

func TestFirstStep(t *testing.T) {
	if FirstStep(TypeMega) != MegaStepEmail {
		t.Fatal("mega 第一步应是邮箱")
	}
	if FirstStep(TypeProton) != ProtonStepUser {
		t.Fatal("proton 第一步应是用户名")
	}
	if FirstStep("nope") != "" {
		t.Fatal("未支持类型该返回空")
	}
}

func TestCancelled(t *testing.T) {
	for _, s := range []string{"/cancel", "cancel", "取消", "/取消", " 取消 "} {
		if !Cancelled(s) {
			t.Fatalf("%q 应识别为取消", s)
		}
	}
	if Cancelled("continue") {
		t.Fatal("普通输入不该算取消")
	}
}

func TestMain(m *testing.M) {
	// 测试里不真跑 rclone:obscure 注入成假实现(原样返回 + 前缀标记)。
	// 状态机只关心「落库的密码已被处理过」,不关心 obscure 算法本身。
	SetObscureRunner(nil)
	obscureFn = func(ctx context.Context, password string) (string, error) {
		return "obscured:" + password, nil
	}
	os.Exit(m.Run())
}

// 编译期保证 fake 实现满足接口。
var _ ProtonRuntime = (*fakeProtonRuntime)(nil)
