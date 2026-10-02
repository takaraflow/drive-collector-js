package auth

import (
	"testing"
)

// TestRoleHierarchy 角色是【等级制】,admin 自动有 user 的一切权限。
//
// 这不是 bug,是 JS 侧 isRoleAllowed 用 `r >= required` 的语义。
// 改成集合制会让 admin 突然失去基础权限。
func TestRoleHierarchy(t *testing.T) {
	cases := []struct {
		role    Role
		action  Action
		allowed bool
	}{
		{RoleBanned, ActionFileView, false},
		{RoleUser, ActionFileView, true},
		{RoleUser, ActionSystemAdmin, false},
		{RoleTrusted, ActionFileView, true},
		{RoleTrusted, ActionSystemAdmin, false},
		{RoleAdmin, ActionFileView, true},
		{RoleAdmin, ActionSystemAdmin, true}, // 等级制:admin ≥ admin
		{RoleOwner, ActionSystemAdmin, true},
		{RoleAdmin, ActionUserManage, true},
		{RoleTrusted, ActionUserManage, false},
		{RoleBanned, ActionTaskCreate, false},
	}

	for _, tc := range cases {
		got := isRoleAllowed(tc.role, ACL[tc.action])
		if got != tc.allowed {
			t.Errorf("%s 执行 %s = %v,期望 %v", tc.role, tc.action, got, tc.allowed)
		}
	}
}

// TestUnknownRoleHasNoPermission 未知角色等级是 -1,不该有任何权限。
func TestUnknownRoleHasNoPermission(t *testing.T) {
	if isRoleAllowed(Role("superuser"), ACL[ActionFileView]) {
		t.Error("未知角色不该有权限 —— 数据库被写坏才会出现这种情况")
	}
}

// TestDefaultRoleIsUser 查不到角色时默认 user,不是 banned。
//
// 反了的话所有新用户都用不了基础功能。
func TestDefaultRoleIsUser(t *testing.T) {
	if DefaultRole != RoleUser {
		t.Errorf("DefaultRole = %q,应为 user", DefaultRole)
	}
}

// TestRoleOrderMatters 等级顺序不能被改动 ——
// 索引即等级,调换顺序会改变所有权限判定。
func TestRoleOrderM(t *testing.T) {
	want := []Role{RoleBanned, RoleUser, RoleTrusted, RoleAdmin, RoleOwner}
	if len(RoleOrder) != len(want) {
		t.Fatalf("RoleOrder 长度 = %d,期望 %d", len(RoleOrder), len(want))
	}
	for i := range want {
		if RoleOrder[i] != want[i] {
			t.Errorf("RoleOrder[%d] = %q,期望 %q", i, RoleOrder[i], want[i])
		}
	}
	// 等级必须严格递增
	for i := 1; i < len(RoleOrder); i++ {
		if roleRank(RoleOrder[i]) <= roleRank(RoleOrder[i-1]) {
			t.Errorf("等级未递增:%q 应高于 %q", RoleOrder[i], RoleOrder[i-1])
		}
	}
}

// TestCommandPermissionsMatchJS 命令权限映射必须与 JS 侧一致。
func TestCommandPermissionsMatchJS(t *testing.T) {
	// 这些必须受控 —— 少一条就意味着普通用户能执行管理命令。
	mustGuard := []string{
		"/drive", "/unbind", "/logout",
		"/diagnosis", "/open_service", "/close_service", "/task_queue",
		"/users", "/ban", "/unban", "/pro_admin", "/de_admin",
	}
	for _, cmd := range mustGuard {
		if _, ok := CommandPermissions[cmd]; !ok {
			t.Errorf("命令 %s 必须受权限控制", cmd)
		}
	}

	// 这些在 JS 侧就没有权限限制,照搬才能行为一致。
	// 加了会让普通用户被拒 —— 那是「切过去就有人用不了 /status」。
	noGuard := []string{"/status", "/files", "/help", "/start", "/scan_dup"}
	for _, cmd := range noGuard {
		if _, ok := CommandPermissions[cmd]; ok {
			t.Errorf("命令 %s 在 JS 侧不受权限控制,加了会让普通用户被拒", cmd)
		}
	}
}

// TestEveryCommandPermissionHasACL 每个命令的权限都要在 ACL 里有定义。
//
// 漏了的话 isRoleAllowed 拿到空列表会【返回 true】——
// 看起来有权限控制,实际全放行。这是静默的安全洞。
func TestEveryCommandPermissionHasACL(t *testing.T) {
	for cmd, action := range CommandPermissions {
		allowed, ok := ACL[action]
		if !ok {
			t.Errorf("命令 %s 用的权限 %s 不在 ACL 里 —— 会静默放行", cmd, action)
			continue
		}
		if len(allowed) == 0 {
			t.Errorf("命令 %s 的权限 %s 是空列表 —— 等于不检查", cmd, action)
		}
	}
}

// TestAdminCommandsRequireAdmin 管理命令必须要求 admin 级。
func TestAdminCommandsRequireAdmin(t *testing.T) {
	for _, cmd := range []string{"/users", "/ban", "/unban", "/diagnosis"} {
		action := CommandPermissions[cmd]
		allowed, ok := ACL[action]
		if !ok {
			t.Errorf("%s 的权限 %s 不在 ACL 里", cmd, action)
			continue
		}
		if !isRoleAllowed(RoleAdmin, allowed) {
			t.Errorf("%s 要求 %s,但 admin 都不够", cmd, action)
		}
		if isRoleAllowed(RoleUser, allowed) {
			t.Errorf("%s 普通用户也能执行 —— 权限配置错了", cmd)
		}
	}
}

// TestDriveCommandsRequireDriveEdit 网盘命令的权限必须正确。
func TestDriveCommandsRequireDriveEdit(t *testing.T) {
	for _, cmd := range []string{"/drive", "/unbind", "/logout"} {
		if got := CommandPermissions[cmd]; got != ActionDriveEdit {
			t.Errorf("%s 需要 %s,实际 %s", cmd, ActionDriveEdit, got)
		}
	}
}

// TestValidPersistedOwnerCannotBeStored owner 来自配置,不能落库。
//
// 落库后改配置会导致「配置说不是 owner、数据库说是 owner」的分裂,
// 而 getRole 优先看配置 —— 分裂结果是数据库里那条永远不生效。
func TestValidPersistedOwnerCannotBeStored(t *testing.T) {
	if validPersisted(RoleOwner) {
		t.Error("owner 不该能被 SetRole 写入 —— 它只来自配置")
	}
	for _, r := range []Role{RoleBanned, RoleUser, RoleTrusted, RoleAdmin} {
		if !validPersisted(r) {
			t.Errorf("角色 %s 该允许落库", r)
		}
	}
}
