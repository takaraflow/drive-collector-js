-- 系统设置表：用于存储系统配置项
-- 注意：SettingsRepository 使用 Cache 作为主存储，此表仅作为备份或特殊场景使用
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
    updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

-- 索引优化（虽然主键已优化，但保留结构一致性）
-- settings 表通常通过主键查询，不需要额外索引
