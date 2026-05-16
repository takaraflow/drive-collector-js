-- 网盘配置表：用于存储用户绑定的网盘信息
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

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_drives_user_id ON drives(user_id);
CREATE INDEX IF NOT EXISTS idx_drives_status ON drives(status);
CREATE INDEX IF NOT EXISTS idx_drives_type ON drives(type);
CREATE INDEX IF NOT EXISTS idx_drives_user_status ON drives(user_id, status);
CREATE INDEX IF NOT EXISTS idx_drives_user_default ON drives(user_id, is_default);
CREATE UNIQUE INDEX IF NOT EXISTS idx_drives_one_default_per_user ON drives(user_id) WHERE is_default = 1 AND status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_drives_one_active_type_per_user ON drives(user_id, type) WHERE status = 'active';
