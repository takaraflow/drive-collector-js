-- 数据库初始化脚本
-- 包含项目首次创建和 D1 数据库初始化所需的所有 SQL 语句

-- 1. Schema 迁移版本表：由 scripts/db-migrate.js 维护
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    execution_time_ms INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS schema_migration_lock (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 2. 任务表：用于存储文件传输任务
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT,
    msg_id INTEGER,
    source_msg_id INTEGER,
    file_name TEXT,
    file_size INTEGER DEFAULT 0,
    status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'downloading', 'downloaded', 'uploading', 'completed', 'failed', 'cancelled')),
    error_msg TEXT,
    claimed_by TEXT,
    created_at INTEGER,
    updated_at INTEGER
);

-- 任务表索引
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_msg_id ON tasks(msg_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at);

-- 3. 网盘配置表：用于存储用户绑定的网盘信息
CREATE TABLE IF NOT EXISTS drives (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT,
    type TEXT NOT NULL,
    config_data TEXT NOT NULL,
    remote_folder TEXT,  -- 用户自定义上传目录
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
    is_default INTEGER DEFAULT 0 CHECK (is_default IN (0, 1)),
    created_at INTEGER,
    updated_at INTEGER
);

-- 网盘配置表索引
CREATE INDEX IF NOT EXISTS idx_drives_user_id ON drives(user_id);
CREATE INDEX IF NOT EXISTS idx_drives_status ON drives(status);
CREATE INDEX IF NOT EXISTS idx_drives_type ON drives(type);
CREATE INDEX IF NOT EXISTS idx_drives_user_status ON drives(user_id, status);
CREATE INDEX IF NOT EXISTS idx_drives_user_default ON drives(user_id, is_default);
CREATE UNIQUE INDEX IF NOT EXISTS idx_drives_one_default_per_user ON drives(user_id) WHERE is_default = 1 AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_drives_one_active_type_per_user ON drives(user_id, type) WHERE status = 'active';

-- 4. 系统设置表：用于存储系统配置项和用户自定义设置
-- 注意：SettingsRepository 使用 Cache 作为主存储，此表仅作为备份或特殊场景使用
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- 5. 会话表：用于存储用户会话状态
-- 注意：SessionManager 使用 Cache 作为主存储，此表仅作为备份或特殊场景使用
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    expires_at INTEGER
);

-- 会话表索引
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- 6. API Keys 表：用于 MCP 多租户访问令牌
CREATE TABLE IF NOT EXISTS api_keys (
    user_id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_token ON api_keys(token);

-- 7. 用户角色表：用于权限控制
CREATE TABLE IF NOT EXISTS user_roles (
    user_id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('banned', 'user', 'trusted', 'admin')),
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role);
