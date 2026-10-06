package app

import (
	"context"
	"fmt"
	"strings"

	"github.com/youngsx/drive-collector/cmd/collector/internal/drive"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// 本文件是绑定向导的编排:接住用户每条输入,推进状态机,最后落库。
//
// 与 JS 侧 DriveConfigFlow._processInput + BindingService.handleInput
// 对齐,但只覆盖 Go 已实现的 mega / protondrive 两个类型。

// stepType 从会话步骤里解出 (driveType, stepName)。
//
// 与 JS 侧 decodeDriveSessionStep 的 "TYPE:STEP" 格式一致。旧格式
// (TYPE_STEP 前缀)是给历史遗留的 —— Redis 会话 24h 过期,上线切换
// 期一过就自然消失,这里不兼容它。
func stepType(currentStep string) (drive.Type, string, bool) {
	idx := strings.Index(currentStep, ":")
	if idx <= 0 || idx == len(currentStep)-1 {
		return "", "", false
	}
	return drive.Type(strings.ToLower(currentStep[:idx])), currentStep[idx+1:], true
}

// encodeStep 与 JS encodeDriveSessionStep 一致:大写类型 + ":" + 步骤。
func encodeStep(t drive.Type, step string) string {
	return strings.ToUpper(string(t)) + ":" + step
}

// bindStart 开始一次绑定:建会话,发第一步提示。
func (a *App) bindStart(ctx context.Context, chatID int64, userID, typeStr string) error {
	t := drive.Type(typeStr)
	if !drive.IsSupported(t) {
		return a.sendSafe(ctx, chatID, "⚠️ 暂不支持该网盘类型。当前可用:Mega、Proton Drive。")
	}
	step := drive.FirstStep(t)
	if step == "" {
		return a.sendSafe(ctx, chatID, "⚠️ 暂不支持该网盘类型。")
	}
	if err := a.bindSessions.Start(ctx, userID, strings.ToUpper(typeStr)+":"+step, nil); err != nil {
		return fmt.Errorf("启动绑定会话失败: %w", err)
	}

	var prompt string
	switch t {
	case drive.TypeMega:
		prompt = "📧 <b>请输入您的 Mega 登录邮箱</b>：\n\n发送 /cancel 或输入 取消 可随时退出绑定流程。"
	case drive.TypeProton:
		prompt = "👤 <b>请输入 Proton 账号用户名</b>\n\n通常是邮箱，例如 <code>you@proton.me</code>。\n\n发送 /cancel 或输入 取消 可随时退出绑定流程。" +
			"\n\n🔒 提示:涉及密码的输入在提交后会被立即删除。"
	}
	return a.tg.SendMessage(ctx, chatID, prompt)
}

// handleBindInput 处理绑定会话中的文本输入。返回 true 表示消息被
// 绑定流程消费(不再当普通聊天/文件)。
func (a *App) handleBindInput(ctx context.Context, msg messageInfo, text string) bool {
	if !a.bindDriveReady() {
		return false
	}
	userID := fmt.Sprintf("%d", msg.SenderID)
	sess, err := a.bindSessions.Get(ctx, userID)
	if err != nil {
		a.log.Error("读绑定会话失败", "err", err)
		return false // 读不出状态就别拦消息 —— 拦了用户什么都做不了
	}
	if sess == nil || sess.CurrentStep == "" {
		return false
	}

	driveType, step, ok := stepType(sess.CurrentStep)
	if !ok {
		// 坏会话:清掉,别让用户永远卡在向导里。
		_ = a.bindSessions.Clear(ctx, userID)
		return false
	}

	// 敏感步骤(密码/2FA)的原始消息要删 —— 凭据留在聊天记录里是隐患。
	// 与 JS 侧 isSensitiveBindingStep 一致:WAIT_PASS / WAIT_PASSWORD / WAIT_2FA。
	if isSensitiveStep(step) {
		if err := a.tg.DeleteMessages(ctx, msg.ChatID, []int64{int64(msg.ID)}); err != nil {
			a.log.Warn("删除敏感输入失败(不影响流程)", "err", err)
		}
	}

	var res drive.BindResult
	switch driveType {
	case drive.TypeMega:
		res = drive.HandleMegaStep(ctx, a.rcloneRunner, step, text, sess.Data)
	case drive.TypeProton:
		res = drive.HandleProtonStep(ctx, a.bindRuntime, step, text, sess.Data)
	default:
		_ = a.bindSessions.Clear(ctx, userID)
		return false
	}

	if res.Failed {
		_ = a.bindSessions.Clear(ctx, userID)
	}
	if !res.Success {
		// 输入错(中间或终态):提示。中间步骤会话保留可重输,终态已清。
		_ = a.tg.SendMessage(ctx, msg.ChatID, res.Message)
		return true
	}

	if res.NextStep != "" {
		if err := a.bindSessions.Update(ctx, userID,
			strings.ToUpper(string(driveType))+":"+res.NextStep, res.Data); err != nil {
			a.log.Error("更新绑定会话失败", "err", err)
		}
		a.sendSafe(ctx, msg.ChatID, res.Message)
		return true
	}

	// 终态:Config 为 nil = 取消类提示。
	if res.Config == nil {
		_ = a.bindSessions.Clear(ctx, userID)
		a.sendSafe(ctx, msg.ChatID, res.Message)
		return true
	}

	// 成功:落库,清会话。
	if err := a.createBoundDrive(ctx, userID, driveType, res); err != nil {
		_ = a.bindSessions.Clear(ctx, userID)
		a.log.Error("绑定落库失败", "userId", userID, "err", err)
		a.sendSafe(ctx, msg.ChatID, "❌ <b>绑定失败</b>\n\n保存配置时出错,请稍后重试。")
		return true
	}
	_ = a.bindSessions.Clear(ctx, userID)
	a.sendWithButtons(ctx, msg.ChatID, res.Message, [][]tgclient.Button{
		{{Text: "📁 浏览文件", Data: "files_page_0"}},
	})
	return true
}

// createBoundDrive 把验证过的配置写进 drives 表。
//
// 与 JS DriveRepository.create 对齐:同类型已有 active 盘时复用那行
// (更新凭据),否则新插入;首个盘自动设为默认。
func (a *App) createBoundDrive(ctx context.Context, userID string, t drive.Type, res drive.BindResult) error {
	existing, err := a.drivesList(ctx, userID)
	if err != nil {
		return err
	}
	for i := range existing {
		d := &existing[i]
		if d.Type == string(t) && d.Status == "active" {
			// 复用行:更新 config。DriveRepo 现有接口只有 UpdateConfigData,
			// 恰好够用 —— 名字/类型不变。
			return a.drives.UpdateConfigData(ctx, d.ID, d.UserID, *res.Config)
		}
	}

	// 没有现成的:插入。store 层还没有 Create,这里直接走 SQL ——
	// 放 store 里是正办,但为了不扩散接口先内联,注释为证。
	return a.insertDrive(ctx, userID, res.DriveName, string(t), *res.Config)
}

// isSensitiveStep 报告该步骤的原始消息是否该删。
// 与 JS isSensitiveBindingStepName 对齐(WAIT_PASS / WAIT_PASSWORD / WAIT_2FA)。
func isSensitiveStep(step string) bool {
	switch step {
	case "WAIT_PASS", "WAIT_PASSWORD", "WAIT_2FA":
		return true
	}
	return false
}

func (a *App) sendSafe(ctx context.Context, chatID int64, text string) error {
	if err := a.tg.SendMessage(ctx, chatID, text); err != nil {
		a.log.Error("发送消息失败", "chatId", chatID, "err", err)
	}
	return nil
}

func (a *App) sendWithButtons(ctx context.Context, chatID int64, text string, buttons [][]tgclient.Button) error {
	if err := a.tg.SendWithButtons(ctx, chatID, text, buttons); err != nil {
		a.log.Error("发送消息失败", "chatId", chatID, "err", err)
	}
	return nil
}
