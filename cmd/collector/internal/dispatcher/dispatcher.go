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

	// Sessions 清理被封用户的残留状态(绑定会话里存着邮箱密码、
	// 扫描状态)。为 nil 时跳过清理 —— 没装配 Redis 就是没有会话
	// 可清,不该因此把封禁操作判失败。
	Sessions Sessions
}

// Sessions 是封禁后需要收拾干净的东西。
//
// 单独一个接口而不是复用 Authorizer:判权限是每次命令都要,清会话
// 只有封禁那一条路径要。
type Sessions interface {
	ClearUserSessions(ctx context.Context, userID string) error
}

// ownerID 从 Authorizer 拿 owner id —— 不设 Deps 字段。
//
// 单一来源是被现实逼出来的:OwnerID 曾经是 Deps 上的独立字段,而
// 生产装配忘了填,于是 ownerOnly 那道闸在生产上把 owner 自己
// 也拒了(/pro_admin 对所有人不可用),而测试替身填了值,全绿。
// owner id 本来就住在 *auth.Guard 里,从那儿取就漏不掉。
type ownerIDer interface {
	OwnerID() string
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
	case "/ban", "/unban", "/pro_admin", "/de_admin":
		return true, d.handleRoleCommand(ctx, chatID, userID, command, text)
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

// roleCommandSpec 一条「改角色」命令的语义。
type roleCommandSpec struct {
	verb      string // 给用户看的中文动词
	role      auth.Role
	ownerOnly bool // 是否只有 owner 能下这条命令
	noSelf    bool // 是否禁止对自己执行
	noOwner   bool // 是否禁止对 owner 执行(封禁专用)
}

// roleCommands 把四条改角色的命令归到同一个流程。
//
// /de_admin 对应 JS 的 removeRole —— 删掉记录、回落到默认角色 user,
// 与显式写 user 等价,所以共用一个出口。
var roleCommands = map[string]roleCommandSpec{
	"/ban":       {verb: "封禁", role: auth.RoleBanned, noSelf: true, noOwner: true},
	"/unban":     {verb: "解封", role: auth.RoleUser},
	"/pro_admin": {verb: "设为管理员", role: auth.RoleAdmin, ownerOnly: true},
	"/de_admin":  {verb: "取消管理员", role: auth.RoleUser, ownerOnly: true},
}

// handleRoleCommand 处理封禁/解封/升降管理员。
//
// B 方案砍掉「二次确认」—— 那是为了防误操作,代价是 227 行 nonce
// 链路。管理命令数量少、影响大,这里保留一个显式的参数确认:
// 必须写成 `/<命令> <uid> confirm` 才真的执行。
func (d *Dispatcher) handleRoleCommand(ctx context.Context, chatID int64, userID, command, text string) error {
	spec, ok := roleCommands[command]
	if !ok {
		return nil
	}

	// ownerOnly 是给 CommandPermissions 之上的第二道闸:那里把
	// ActionUserManage 放行给 admin,而「谁是管理员」只能由 owner 定,
	// 否则任何 admin 都能给自己升官。
	if spec.ownerOnly {
		o := d.owner()
		if o == "" || userID != o {
			return d.send(ctx, chatID, "❌ 您没有权限执行此操作。")
		}
	}

	fields := strings.Fields(text)
	if len(fields) < 2 {
		return d.send(ctx, chatID,
			fmt.Sprintf("用法:<code>/%s &lt;用户ID&gt; confirm</code>\n\n"+
				"加 <code>confirm</code> 才真的执行 —— 防误操作。", command))
	}
	target := fields[1]
	if spec.noSelf && target == userID {
		return d.send(ctx, chatID, "❌ 不能对自己执行此操作。")
	}
	// owner 由配置决定、不落库,SetRole 对它写了也不生效 —— 但命令会回
	// 「✅ 已封禁」,用户以为封住了其实没封,库里还多一行脏数据。
	// JS 侧有这道拦截,这里补齐(Dispatcher.js _handleBanCommand)。
	if spec.noOwner && d.owner() != "" && target == d.owner() {
		return d.send(ctx, chatID, "❌ 不能封禁系统所有者。")
	}
	if len(fields) < 3 || fields[2] != "confirm" {
		return d.send(ctx, chatID, fmt.Sprintf(
			"⚠️ 即将%s 用户 <code>%s</code>。\n\n确认请再发一次并加 <code>confirm</code>。",
			spec.verb, escapeHTML(target)))
	}

	if err := d.setRole(ctx, target, spec.role); err != nil {
		return d.send(ctx, chatID, "❌ 操作失败:"+escapeHTML(err.Error()))
	}
	// 角色已落库,清理失败不能改口说「失败」—— 用户会以为没封上而
	// 重发一遍。只记日志:残留会话最坏是过期,谎报才是真问题。
	if spec.role == auth.RoleBanned {
		d.clearSessions(ctx, target)
	}
	return d.send(ctx, chatID, fmt.Sprintf("✅ 已%s 用户 <code>%s</code>", spec.verb, escapeHTML(target)))
}

// clearSessions 清被封用户的残留状态。
func (d *Dispatcher) clearSessions(ctx context.Context, userID string) {
	if d.deps.Sessions == nil {
		return
	}
	if err := d.deps.Sessions.ClearUserSessions(ctx, userID); err != nil {
		d.deps.Log.Error("清理被封用户会话失败", "userId", userID, "err", err)
	}
}

// setRole 写角色 —— 需要 Authorizer 支持写入。
//
// 用类型断言而不是改 Authorizer 接口:读权限是每个 handler 都要的,
// 写权限只有 /ban /unbind 需要。让接口带上写方法会逼所有 mock 都实现它。
func (d *Dispatcher) setRole(ctx context.Context, target string, role auth.Role) error {
	w, ok := d.deps.Auth.(roleWriter)
	if !ok {
		return fmt.Errorf("权限层不支持写角色")
	}
	return w.SetRole(ctx, target, role)
}

type roleWriter interface {
	SetRole(ctx context.Context, userID string, role auth.Role) error
}

// owner 返回 owner telegram id。拿不到就是空串 —— 空串让 ownerOnly
// 的命令对所有人关闭(fail-closed),比默认为空后误放行安全。
func (d *Dispatcher) owner() string {
	if o, ok := d.deps.Auth.(ownerIDer); ok {
		return o.OwnerID()
	}
	return ""
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
