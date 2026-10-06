// Package auth 是 RBAC 权限层。
//
// 与 JS 侧 src/modules/AuthGuard.js 逐字对齐 —— ACL 表、角色等级
// 都是跨语言共享的语义,漂移会导致「某个用户突然能执行管理命令」
// 或反过来被拒。
//
// 角色是【等级制】而非集合制:isRoleAllowed 用的是 `r >= required`,
// 所以 admin 自动拥有 user 的一切权限。这是 JS 侧的行为,不是 bug。
package auth

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/d1"
)

// Role 是用户角色。
type Role string

const (
	RoleBanned  Role = "banned"
	RoleUser    Role = "user"
	RoleTrusted Role = "trusted"
	RoleAdmin   Role = "admin"
	RoleOwner   Role = "owner"
)

// RoleOrder 与 JS 侧 ROLE_ORDER 一致 —— 索引即等级。
//
// 顺序有意义:banned 最低(owner 最高)。改这个顺序会改变所有权限判定。
var RoleOrder = []Role{RoleBanned, RoleUser, RoleTrusted, RoleAdmin, RoleOwner}

// DefaultRole 与 JS 侧 DEFAULT_ROLE 一致:查不到就是 user。
//
// 注意不是 banned —— 新用户默认能用基础功能。
const DefaultRole = RoleUser

// Action 是受控操作。
type Action string

const (
	ActionTaskCreate        Action = "task:create"
	ActionFileView          Action = "file:view"
	ActionDriveView         Action = "drive:view"
	ActionDriveEdit         Action = "drive:edit"
	ActionTaskManage        Action = "task:manage"
	ActionUserManage        Action = "user:manage"
	ActionSystemAdmin       Action = "system:admin"
	ActionMaintenanceBypass Action = "maintenance:bypass"
	ActionTaskCancelAny     Action = "task:cancel:any"
	ActionExternalLink      Action = "external_link:create"
)

// ACL 与 JS 侧 ACL 逐字对应。
var ACL = map[Action][]Role{
	ActionTaskCreate:  {RoleUser, RoleTrusted, RoleAdmin, RoleOwner},
	ActionFileView:    {RoleUser, RoleTrusted, RoleAdmin, RoleOwner},
	ActionDriveView:   {RoleUser, RoleTrusted, RoleAdmin, RoleOwner},
	ActionDriveEdit:   {RoleUser, RoleTrusted, RoleAdmin, RoleOwner},
	ActionTaskManage:  {RoleAdmin, RoleOwner},
	ActionUserManage:  {RoleAdmin, RoleOwner},
	ActionSystemAdmin: {RoleAdmin, RoleOwner},

	ActionMaintenanceBypass: {RoleAdmin, RoleOwner},
	ActionTaskCancelAny:     {RoleAdmin, RoleOwner},
	ActionExternalLink:      {RoleAdmin, RoleOwner},
}

// CommandPermissions 是命令 → 所需权限的映射。
//
// 与 JS 侧 COMMAND_PERMISSIONS 逐字对应。注意「没列出的命令不受权限
// 控制」—— 这是 JS 侧的行为,/status /files /help 就在其中。
var CommandPermissions = map[string]Action{
	// 网盘管理(高危)
	"/drive":             ActionDriveEdit,
	"/logout":            ActionDriveEdit,
	"/unbind":            ActionDriveEdit,
	"/remote_folder":     ActionDriveEdit,
	"/set_remote_folder": ActionDriveEdit,

	// 系统管理
	"/diagnosis":      ActionSystemAdmin,
	"/open_service":   ActionSystemAdmin,
	"/close_service":  ActionSystemAdmin,
	"/status_public":  ActionSystemAdmin,
	"/status_private": ActionSystemAdmin,
	"/task_queue":     ActionSystemAdmin,

	// 用户管理
	"/users":     ActionUserManage,
	"/pro_admin": ActionUserManage,
	"/de_admin":  ActionUserManage,
	"/ban":       ActionUserManage,
	"/unban":     ActionUserManage,
}

// roleRank 返回角色等级,未知角色返回 -1。
func roleRank(r Role) int {
	for i, v := range RoleOrder {
		if v == r {
			return i
		}
	}
	return -1
}

// isRoleAllowed 等级比较:r >= 任一所需角色的等级。
func isRoleAllowed(role Role, allowed []Role) bool {
	if len(allowed) == 0 {
		return true // 无约束
	}
	r := roleRank(role)
	for _, a := range allowed {
		if r >= roleRank(a) {
			return true
		}
	}
	return false
}

// Guard 做权限判定。
type Guard struct {
	db      *d1.Client
	ownerID string
	log     Logger

	mu    sync.RWMutex
	cache map[string]cacheEntry
	now   func() time.Time
}

type cacheEntry struct {
	role Role
	ts   int64
}

type Logger interface {
	Warn(msg string, args ...any)
}

const (
	cacheTTL        = 5 * time.Minute
	maxCacheEntries = 1000
)

// NewGuard 构造权限守卫。
func NewGuard(db *d1.Client, ownerID string, log Logger) *Guard {
	return &Guard{
		db:      db,
		ownerID: ownerID,
		log:     log,
		cache:   map[string]cacheEntry{},
		now:     time.Now,
	}
}

// OwnerID 返回配置里的 owner telegram id(可能为空)。
//
// /users 要用它标出「所有者」—— owner 不落库,只存在于配置,
// 所以列表查询必须把它当参数喂进去,否则管理员永远看不到自己。
func (g *Guard) OwnerID() string { return g.ownerID }

// Role 取用户角色。
func (g *Guard) Role(ctx context.Context, userID string) (Role, error) {
	if userID == "" {
		return DefaultRole, nil
	}
	// owner 不查库 —— 它由配置决定,不持久化。
	if g.ownerID != "" && userID == g.ownerID {
		return RoleOwner, nil
	}

	now := g.now()
	g.mu.RLock()
	if e, ok := g.cache[userID]; ok && now.Sub(time.UnixMilli(e.ts)) < cacheTTL {
		g.mu.RUnlock()
		return e.role, nil
	}
	g.mu.RUnlock()

	row, err := g.db.FetchOne(ctx,
		"SELECT role FROM user_roles WHERE user_id = ?", userID)
	if err != nil {
		return "", fmt.Errorf("查询用户 %s 的角色失败: %w", userID, err)
	}

	role := DefaultRole
	if row != nil {
		if s, ok := row["role"].(string); ok && s != "" {
			role = Role(s)
		}
	}

	g.mu.Lock()
	g.cache[userID] = cacheEntry{role: role, ts: now.UnixMilli()}
	// 缓存无界增长会吃内存;超量时丢最旧的。
	if len(g.cache) > maxCacheEntries {
		var oldestKey string
		var oldestTS int64
		first := true
		for k, v := range g.cache {
			if first || v.ts < oldestTS {
				oldestKey, oldestTS, first = k, v.ts, false
			}
		}
		delete(g.cache, oldestKey)
	}
	g.mu.Unlock()

	return role, nil
}

// Can 判断用户是否有权限执行操作。
func (g *Guard) Can(ctx context.Context, userID string, action Action) (bool, error) {
	role, err := g.Role(ctx, userID)
	if err != nil {
		return false, err
	}
	return isRoleAllowed(role, ACL[action]), nil
}

// CanRunCommand 命令级权限判定。未登记的命令放行 ——
// 与 JS 侧一致:COMMAND_PERMISSIONS 里没有的就不拦。
func (g *Guard) CanRunCommand(ctx context.Context, userID, command string) (bool, error) {
	action, restricted := CommandPermissions[command]
	if !restricted {
		return true, nil
	}
	return g.Can(ctx, userID, action)
}

// SetRole 设置用户角色并让缓存失效。
func (g *Guard) SetRole(ctx context.Context, userID string, role Role) error {
	if !validPersisted(role) {
		return fmt.Errorf("auth: 非法角色 %q(允许 banned/user/trusted/admin)", role)
	}
	now := g.now().UnixMilli()
	_, err := g.db.Exec(ctx, `
		INSERT INTO user_roles (user_id, role, created_at, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
		userID, string(role), now, now)
	if err != nil {
		return fmt.Errorf("设置用户 %s 的角色失败: %w", userID, err)
	}
	g.mu.Lock()
	delete(g.cache, userID)
	g.mu.Unlock()
	return nil
}

// validPersisted 只有这四个角色能落库 —— owner 来自配置,不持久化。
func validPersisted(r Role) bool {
	switch r {
	case RoleBanned, RoleUser, RoleTrusted, RoleAdmin:
		return true
	}
	return false
}

// IsBanned 是否被封禁 —— 封禁用户发任何消息都不处理。
func (g *Guard) IsBanned(ctx context.Context, userID string) (bool, error) {
	role, err := g.Role(ctx, userID)
	if err != nil {
		return false, err
	}
	return role == RoleBanned, nil
}
