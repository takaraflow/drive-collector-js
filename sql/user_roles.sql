-- 用户角色表：用于权限控制
CREATE TABLE IF NOT EXISTS user_roles (
    user_id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('banned', 'user', 'trusted', 'admin')),
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);
