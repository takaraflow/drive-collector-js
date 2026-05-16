-- Schema migration metadata table.
-- Maintained by scripts/db-migrate.js.

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
