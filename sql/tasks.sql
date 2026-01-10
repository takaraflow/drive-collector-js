-- 任务表：用于存储文件传输任务
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

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_msg_id ON tasks(msg_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at);
