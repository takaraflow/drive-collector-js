-- 系统设置表：用于存储系统配置项和用户自定义设置
-- 注意：SettingsRepository 使用 Cache 作为主存储，此表仅作为备份或特殊场景使用
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);
