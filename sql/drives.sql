-- 网盘配置表：用于存储用户绑定的网盘信息
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

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_drives_user_id ON drives(user_id);
CREATE INDEX IF NOT EXISTS idx_drives_status ON drives(status);
CREATE INDEX IF NOT EXISTS idx_drives_type ON drives(type);
CREATE INDEX IF NOT EXISTS idx_drives_user_status ON drives(user_id, status);
