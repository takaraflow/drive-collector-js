-- SSOT task status migration for existing D1/SQLite databases.
--
-- SQLite cannot add a CHECK constraint to an existing column in place, so this
-- rebuilds the tasks table with the same known schema and the canonical status
-- constraint. If any existing row has an invalid status, the INSERT fails and
-- the transaction is rolled back; clean the data explicitly before retrying.

PRAGMA foreign_keys=off;

BEGIN TRANSACTION;

CREATE TABLE tasks_ssot_new (
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

INSERT INTO tasks_ssot_new (
    id,
    user_id,
    chat_id,
    msg_id,
    source_msg_id,
    file_name,
    file_size,
    status,
    error_msg,
    claimed_by,
    created_at,
    updated_at
)
SELECT
    id,
    user_id,
    chat_id,
    msg_id,
    source_msg_id,
    file_name,
    file_size,
    status,
    error_msg,
    claimed_by,
    created_at,
    updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_ssot_new RENAME TO tasks;

CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_msg_id ON tasks(msg_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at);

COMMIT;

PRAGMA foreign_keys=on;
