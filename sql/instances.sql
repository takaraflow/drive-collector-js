-- 实例表：用于管理多实例运行状态
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

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_instances_status ON instances(status);
CREATE INDEX IF NOT EXISTS idx_instances_last_heartbeat ON instances(last_heartbeat);
CREATE INDEX IF NOT EXISTS idx_instances_status_heartbeat ON instances(status, last_heartbeat);
