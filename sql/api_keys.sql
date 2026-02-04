-- API Keys for Multi-tenant MCP access
CREATE TABLE IF NOT EXISTS api_keys (
    user_id TEXT PRIMARY KEY,
    token TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_token ON api_keys(token);
