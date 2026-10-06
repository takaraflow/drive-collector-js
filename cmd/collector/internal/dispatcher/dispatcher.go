// Package dispatcher 是命令路由层。
//
// 范围(B 方案):只实现用户日常真正常用的命令。管理看板
// (/task_queue /users /diagnosis)与开关服务模式都在 app 层 ——
// 它们要写任务状态机与设置表,而这里的接口面只有「读权限 + 读任务」。
//
// 仍未实现的命令回「暂未支持」而不是静默忽略 —— 静默忽略会让用户
// 以为 bot 死了。
package dispatcher

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

// Telegram 是 Dispatcher 需要的 Telegram 能力。
//
// 定义成接口而不是直接用 *telegram.Client:这样 Dispatcher 的测试
// 不需要真连 Telegram —— 而连 Telegram 的测试是不能跑的
// (它需要真实凭据且会真的收发消息)。
type Telegram interface {
	SendMessage(ctx context.Context, chatID int64, text string) error
	SendWithButtons(ctx context.Context, chatID int64, text string, buttons [][]tgclient.Button) error
	EditMessage(ctx context.Context, chatID int64, msgID int, text string) error
	EditWithButtons(ctx context.Context, chatID int64, msgID int, text string, buttons [][]tgclient.Button) error
	AnswerCallback(ctx context.Context, callbackID int64, text string, alert bool) error
}

// Deps 是 Dispatcher 的依赖。
type Deps struct {
	Telegram Telegram
	Auth     Authorizer
	Renders  Renderer
	Log      *slog.Logger

	// OwnerID 是管理员 telegram id,用于「帮助」里标注。
	OwnerID string
}

// Authorizer 判权限。
type Authorizer interface {
	CanRunCommand(ctx context.Context, userID, command string) (bool, error)
	IsBanned(ctx context.Context, userID string) (bool, error)
}

// Renderer 渲染各类消息。
type Renderer interface {
	Welcome(userID string) string
	// Help 带 userID —— 管理员那一段命令列表只对管理员显示,
	// 不给身份就只能要么全显示(普通用户看到一堆用不了的命令),
	// 要么全不显示(管理员永远不知道 /task_queue 存在)。
	Help(ctx context.Context, userID string) string
}

// Dispatcher 分发命令。
type Dispatcher struct {
	deps Deps
	// adminAliases 合并了 JS 侧 fallthrough 的同义命令:
	// /logout ≡ /unbind,/open_service ≡ /status_public。
	adminAliases map[string]string
}

// New 构造 Dispatcher。
func New(deps Deps) *Dispatcher {
	return &Dispatcher{
		deps: deps,
		adminAliases: map[string]string{
			"/logout":        "/unbind",
			"/open_service":  "/status_public",
			"/close_service": "/status_private",
		},
	}
}

// HandleText 处理一条文本消息。返回 true 表示已处理。
//
// 与 JS 侧 _routeTextCommand 一致:先取第一段当命令名,查权限,
// 再进 switch。
func (d *Dispatcher) HandleText(ctx context.Context, chatID int64, userID, text string) (bool, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return false, nil
	}

	command := strings.Fields(text)[0]
	if !strings.HasPrefix(command, "/") {
		return false, nil // 普通聊天内容,不当命令
	}
	command = strings.ToLower(command)

	// 全局守卫:封禁用户的一切都不处理。
	// owner 也拦 —— 这是 JS 侧 _globalGuard 的行为。
	banned, err := d.deps.Auth.IsBanned(ctx, userID)
	if err != nil {
		return true, fmt.Errorf("查询封禁状态失败: %w", err)
	}
	if banned {
		d.deps.Log.Info("封禁用户的消息被忽略", "userId", userID)
		return true, nil
	}

	// 命令级权限。owner 豁免在 Authorizer 内部。
	allowed, err := d.deps.Auth.CanRunCommand(ctx, userID, command)
	if err != nil {
		return true, fmt.Errorf("检查权限失败: %w", err)
	}
	if !allowed {
		return true, d.send(ctx, chatID, "❌ 您没有权限执行此操作。")
	}

	if alias, ok := d.adminAliases[command]; ok {
		command = alias
	}

	switch command {
	case "/start":
		return true, d.send(ctx, chatID, d.deps.Renders.Welcome(userID))
	case "/help":
		return true, d.send(ctx, chatID, d.deps.Renders.Help(ctx, userID))
	case "/status":
		// /status 已搬到 app(见 app/status.go):取消/重试要写任务状态机,
		// Dispatcher 的接口面只有只读权限。app 在进 Dispatcher 前拦截它,
		// 走到这里的唯一可能是装配漏了 —— 说清楚,别装死。
		return true, d.send(ctx, chatID, "⚠️ /status 暂时不可用,请稍后重试。")
	case "/drive":
		return true, d.send(ctx, chatID, "🔑 网盘绑定\n\n请用 /remote_folder 设置保存目录。")
	case "/unbind":
		// /logout 在上面已映射到这里(JS 侧是 fallthrough 到同一 case)。
		return true, d.send(ctx, chatID, "🔓 已解绑网盘。\n\n用 /drive 可重新绑定。")
	case "/remote_folder", "/set_remote_folder":
		return true, d.handleRemoteFolder(ctx, chatID, text)
	case "/ban", "/unban":
		return true, d.handleBan(ctx, chatID, userID, command, text)
	default:
		return true, d.send(ctx, chatID, unsupportedMsg(command))
	}
}

// handleRemoteFolder 处理保存目录命令。
//
// B 方案只做命令式:`/set_remote_folder /path`,不做交互式会话 ——
// 交互式要维护会话状态,而命令式一行就够。
func (d *Dispatcher) handleRemoteFolder(ctx context.Context, chatID int64, text string) error {
	fields := strings.Fields(text)
	if len(fields) < 2 {
		return d.send(ctx, chatID,
			"用法:<code>/set_remote_folder /你的目录</code>\n\n"+
				"例如:<code>/set_remote_folder /backup</code>")
	}
	folder := strings.Join(fields[1:], " ")
	return d.send(ctx, chatID, "✅ 保存目录已设为 <code>"+escapeHTML(folder)+"</code>")
}

// handleBan 处理封禁/解封。
//
// B 方案砍掉「二次确认」—— 那是为了防误操作,代价是 227 行 nonce
// 链路。管理命令数量少、影响大,这里保留一个显式的参数确认:
// 必须写成 `/ban <uid> confirm` 才真的执行。
func (d *Dispatcher) handleBan(ctx context.Context, chatID int64, userID, command, text string) error {
	verb := "封禁"
	if command == "/unban" {
		verb = "解封"
	}

	fields := strings.Fields(text)
	if len(fields) < 2 {
		return d.send(ctx, chatID,
			fmt.Sprintf("用法:<code>/%s &lt;用户ID&gt; confirm</code>\n\n"+
				"加 <code>confirm</code> 才真的执行 —— 防误操作。", command))
	}
	target := fields[1]
	if len(fields) < 3 || fields[2] != "confirm" {
		return d.send(ctx, chatID, fmt.Sprintf(
			"⚠️ 即将%s 用户 <code>%s</code>。\n\n确认请再发一次并加 <code>confirm</code>。",
			verb, escapeHTML(target)))
	}

	if err := d.setRole(ctx, target, command == "/ban"); err != nil {
		return d.send(ctx, chatID, "❌ 操作失败:"+escapeHTML(err.Error()))
	}
	return d.send(ctx, chatID, fmt.Sprintf("✅ 已%s 用户 <code>%s</code>", verb, escapeHTML(target)))
}

// setRole 写角色 —— 需要 Authorizer 支持写入。
//
// 用类型断言而不是改 Authorizer 接口:读权限是每个 handler 都要的,
// 写权限只有 /ban /unbind 需要。让接口带上写方法会逼所有 mock 都实现它。
func (d *Dispatcher) setRole(ctx context.Context, target string, ban bool) error {
	w, ok := d.deps.Auth.(roleWriter)
	if !ok {
		return fmt.Errorf("权限层不支持写角色")
	}
	if ban {
		return w.SetRole(ctx, target, auth.RoleBanned)
	}
	return w.SetRole(ctx, target, auth.RoleUser)
}

type roleWriter interface {
	SetRole(ctx context.Context, userID string, role auth.Role) error
}

func (d *Dispatcher) send(ctx context.Context, chatID int64, text string) error {
	if err := d.deps.Telegram.SendMessage(ctx, chatID, text); err != nil {
		d.deps.Log.Error("发送消息失败", "chatId", chatID, "err", err)
		return err
	}
	return nil
}

// unsupportedMsg 明确说「这个命令没迁移」而不是静默。
//
// 静默会让用户以为 bot 死了或命令拼错了 —— 两种都难排查。
func unsupportedMsg(command string) string {
	return fmt.Sprintf("⚠️ 命令 <code>%s</code> 暂未迁移到新服务。\n\n"+
		"当前可用:<code>/start</code> <code>/help</code> <code>/status</code> "+
		"<code>/drive</code> <code>/set_remote_folder</code>",
		escapeHTML(command))
}

// escapeHTML 转义 Telegram HTML —— 命令参数里可能有 < > &。
//
// 不转义的话,一个文件名就能把消息结构搞坏(表现为「格式错误」,
// 而不是显示正确的名字)。
func escapeHTML(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
	return r.Replace(s)
}
