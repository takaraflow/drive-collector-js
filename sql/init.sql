-- 数据库初始化脚本
-- 包含项目首次创建和 D1 数据库初始化所需的所有 SQL 语句

-- 1. 实例表：用于管理多实例运行状态
CREATE TABLE IF NOT EXISTS instances (
    id TEXT PRIMARY KEY,
    hostname TEXT,
    region TEXT,
    started_at INTEGER,
    last_heartbeat INTEGER,
    status TEXT DEFAULT 'active',
    created_at INTEGER,
    updated_at INTEGER
);

-- 实例表索引
CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status);
CREATE INDEX IF NOT EXISTS idx_instances_last_heartbeat ON instances(last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_instances_status_heartbeat ON instances(status, last_heartbeat);

-- 2. 任务表：用于存储文件传输任务
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    chat_id TEXT,
    msg_id INTEGER,
    source_msg_id INTEGER,
    file_name TEXT,
    file_size INTEGER DEFAULT 0,
    status TEXT DEFAULT 'queued',
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
    status TEXT DEFAULT 'active',
    created_at INTEGER,
    updated_at INTEGER,
    UNIQUE(user_id, type)
);

-- 网盘配置表索引
CREATE INDEX IF NOT EXISTS idx_drives_user_id ON drives(user_id);
CREATE INDEX IF NOT EXISTS idx_drives_status ON drives(status);
CREATE INDEX IF NOT EXISTS idx_drives_type ON drives(type);
CREATE INDEX IF NOT EXISTS idx_drives_user_status ON drives(user_id, status);

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
