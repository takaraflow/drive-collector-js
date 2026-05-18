import Database from "better-sqlite3";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
    LATEST_SCHEMA_VERSION,
    assertDatabaseSchemaCurrent,
    ensureDatabaseSchemaReady,
    getDatabaseSchemaStatus,
    migrateDatabaseSchema
} from "../../../src/database/schema.js";

function createD1(db) {
    return {
        fetchAll: async (sql, params = []) => db.prepare(sql).all(params),
        fetchOne: async (sql, params = []) => db.prepare(sql).get(params) || null,
        run: async (sql, params = []) => db.prepare(sql).run(params),
        raw: async (sql) => db.exec(sql)
    };
}

function createD1RestCompatible(db) {
    const forbiddenPatterns = /\b(BEGIN|COMMIT|SAVEPOINT|ROLLBACK)\b|PRAGMA\s+foreign_keys/i;
    return {
        fetchAll: async (sql, params = []) => {
            if (forbiddenPatterns.test(sql)) {
                throw new Error(`D1 REST rejected SQL: ${sql}`);
            }
            return db.prepare(sql).all(params);
        },
        fetchOne: async (sql, params = []) => {
            if (forbiddenPatterns.test(sql)) {
                throw new Error(`D1 REST rejected SQL: ${sql}`);
            }
            return db.prepare(sql).get(params) || null;
        },
        run: async (sql, params = []) => {
            if (forbiddenPatterns.test(sql)) {
                throw new Error(`D1 REST rejected SQL: ${sql}`);
            }
            return db.prepare(sql).run(params);
        },
        raw: async (sql) => {
            if (forbiddenPatterns.test(sql)) {
                throw new Error(`D1 REST rejected SQL: ${sql}`);
            }
            return db.exec(sql);
        }
    };
}

function createLegacyDatabase() {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE tasks (
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

        CREATE TABLE drives (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT,
            type TEXT NOT NULL,
            config_data TEXT NOT NULL,
            remote_folder TEXT,
            status TEXT DEFAULT 'active',
            created_at INTEGER,
            updated_at INTEGER,
            UNIQUE(user_id, type)
        );
    `);
    return db;
}

function createLegacyDatabaseWithoutDriveUnique() {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE tasks (
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

        CREATE TABLE drives (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT,
            type TEXT NOT NULL,
            config_data TEXT NOT NULL,
            remote_folder TEXT,
            status TEXT DEFAULT 'active',
            created_at INTEGER,
            updated_at INTEGER
        );
    `);
    return db;
}

function createProductionLegacyDatabase() {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            drive_id INTEGER,
            chat_id TEXT NOT NULL,
            msg_id INTEGER NOT NULL,
            source_msg_id INTEGER NOT NULL,
            file_name TEXT NOT NULL,
            file_size INTEGER DEFAULT 0,
            status TEXT NOT NULL,
            error_msg TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER DEFAULT 0
        );

        CREATE TABLE drives (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            type TEXT NOT NULL,
            config_data TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            created_at INTEGER NOT NULL,
            remote_folder TEXT,
            updated_at INTEGER
        );

        CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE sessions (
            user_id TEXT PRIMARY KEY,
            current_step TEXT NOT NULL,
            temp_data TEXT,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE api_keys (
            user_id TEXT PRIMARY KEY,
            token TEXT UNIQUE NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);
        CREATE INDEX idx_drives_user ON drives(user_id);
        CREATE INDEX idx_api_keys_token ON api_keys(token);

        INSERT INTO tasks (
            id, user_id, drive_id, chat_id, msg_id, source_msg_id, file_name, file_size,
            status, error_msg, created_at, updated_at
        ) VALUES (
            'task-prod-1', 'user-prod', 1, 'chat-prod', 100, 99, 'queued.mp4', 42,
            'queued', NULL, 1000, 1000
        );

        INSERT INTO drives (
            id, user_id, name, type, config_data, status, created_at, remote_folder, updated_at
        ) VALUES (
            1, 'user-prod', 'Mega', 'mega', '{"user":"u"}', 'active', 900, '/remote', 950
        );

        INSERT INTO settings (key, value, updated_at) VALUES ('default_drive', '1', 800);
    `);
    return db;
}

function createDatabaseAppliedThroughVersionFive() {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE tasks (
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
        CREATE INDEX idx_tasks_user_id ON tasks(user_id);
        CREATE INDEX idx_tasks_status ON tasks(status);
        CREATE INDEX idx_tasks_msg_id ON tasks(msg_id);
        CREATE INDEX idx_tasks_created_at ON tasks(created_at);
        CREATE INDEX idx_tasks_claimed_by ON tasks(claimed_by);
        CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);
        CREATE INDEX idx_tasks_status_updated ON tasks(status, updated_at);

        CREATE TABLE drives (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            name TEXT,
            type TEXT NOT NULL,
            config_data TEXT NOT NULL,
            remote_folder TEXT,
            status TEXT DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
            is_default INTEGER DEFAULT 0 CHECK (is_default IN (0, 1)),
            created_at INTEGER,
            updated_at INTEGER
        );
        CREATE INDEX idx_drives_user_id ON drives(user_id);
        CREATE INDEX idx_drives_status ON drives(status);
        CREATE INDEX idx_drives_type ON drives(type);
        CREATE INDEX idx_drives_user_status ON drives(user_id, status);
        CREATE INDEX idx_drives_user_default ON drives(user_id, is_default);
        CREATE UNIQUE INDEX idx_drives_one_default_per_user ON drives(user_id) WHERE is_default = 1 AND status = 'active';
        CREATE UNIQUE INDEX idx_drives_one_active_type_per_user ON drives(user_id, type) WHERE status = 'active';

        CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
            updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        );

        CREATE TABLE sessions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            data TEXT NOT NULL,
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
            expires_at INTEGER
        );
        CREATE INDEX idx_sessions_user_id ON sessions(user_id);
        CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

        CREATE TABLE api_keys (
            user_id TEXT PRIMARY KEY,
            token TEXT UNIQUE NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_api_keys_token ON api_keys(token);

        CREATE TABLE user_roles (
            user_id TEXT PRIMARY KEY,
            role TEXT NOT NULL CHECK (role IN ('banned', 'user', 'trusted', 'admin')),
            created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
            updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
        );
        CREATE INDEX idx_user_roles_role ON user_roles(role);

        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at INTEGER NOT NULL,
            execution_time_ms INTEGER DEFAULT 0
        );
        INSERT INTO schema_migrations (version, name, checksum, applied_at, execution_time_ms) VALUES
            (1, 'initial_schema', '1c71fee80eb09f16419d0143c236c9e7e1d2261f80e8dde4b1c591e5539e5ce9', 1778936675151, 17117),
            (2, 'tasks_status_ssot', '1a9b512a4fdc8988ab3e205278c9d41beb4964583b92a8e9af8b35a60d6937f7', 1778936683357, 7454),
            (3, 'drives_default_ssot', '5114937fdba3263de5eda29a075ac29262d7d819b59476b7544e4161a0aace9b', 1778936692390, 8058),
            (4, 'user_roles_ssot', '957c8724b63b7583df88c9944d822169f9ade6a11be8a02d0ba51b7342fc7e66', 1778999743954, 3580),
            (5, 'drives_active_type_unique_ssot', '521fe2516142976cc218f0e21d87304c2d8726962768c13bb202330597047e99', 1778999752948, 8126),
            (6, 'task_claim_lease_fencing', 'a9e9eaf5e227918d03f2446ed0d9c79379fe5392f3d9df51ae46d67082e33971', 1778999760000, 1000);
    `);
    return db;
}

describe("database schema migrations", () => {
    let db;

    afterEach(() => {
        db?.close();
        db = null;
        vi.restoreAllMocks();
    });

    test("should migrate a legacy database and record schema version", async () => {
        db = createLegacyDatabase();
        const d1 = createD1(db);

        const result = await migrateDatabaseSchema({
            d1,
            useLock: false,
            log: { info: vi.fn(), warn: vi.fn() }
        });

        expect(result.status.isCurrent).toBe(true);
        expect(result.status.currentVersion).toBe(LATEST_SCHEMA_VERSION);
        expect(result.results.map(item => item.action)).toEqual(["applied", "applied", "applied", "recorded", "recorded", "recorded", "recorded"]);

        const taskColumns = db.prepare("PRAGMA table_info(tasks)").all().map(column => column.name);
        expect(taskColumns).toContain("source_type");
        expect(taskColumns).toContain("source_ref");

        const driveColumns = db.prepare("PRAGMA table_info(drives)").all().map(column => column.name);
        expect(driveColumns).toContain("is_default");

        const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name);
        expect(indexes).toContain("idx_tasks_claim_lease");
        expect(indexes).toContain("idx_drives_one_default_per_user");
        expect(indexes).toContain("idx_drives_one_active_type_per_user");
        expect(indexes).toContain("idx_user_roles_role");

        const migrations = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
        expect(migrations.map(row => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });

    test("should create current schema with user_roles and active-only drive type uniqueness", async () => {
        db = new Database(":memory:");
        const d1 = createD1(db);

        await migrateDatabaseSchema({
            d1,
            useLock: false,
            log: { info: vi.fn(), warn: vi.fn() }
        });

        const userRolesSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'user_roles'").get().sql;
        expect(userRolesSql).toContain("role TEXT NOT NULL CHECK");

        const drivesSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'drives'").get().sql;
        expect(drivesSql).not.toContain("UNIQUE(user_id, type)");

        db.prepare(
            "INSERT INTO drives (id, user_id, name, type, config_data, status, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run("drive-1", "user-1", "Mega", "mega", "{}", "active", 0, 1, 1);
        expect(() => db.prepare(
            "INSERT INTO drives (id, user_id, name, type, config_data, status, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run("drive-2", "user-1", "Mega2", "mega", "{}", "active", 0, 2, 2)).toThrow();

        db.prepare("UPDATE drives SET status = 'deleted', is_default = 0 WHERE id = ?").run("drive-1");
        db.prepare(
            "INSERT INTO drives (id, user_id, name, type, config_data, status, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run("drive-3", "user-1", "Mega3", "mega", "{}", "active", 0, 3, 3);

        const status = await getDatabaseSchemaStatus({ d1 });
        expect(status.isCurrent).toBe(true);
        expect(status.issues).toEqual([]);
    });

    test("should normalize duplicate active drives before creating active-only type uniqueness", async () => {
        db = createLegacyDatabaseWithoutDriveUnique();
        db.prepare(
            "INSERT INTO drives (id, user_id, name, type, config_data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run("drive-old", "user-dup", "Old", "mega", "{}", "active", 1000, 1000);
        db.prepare(
            "INSERT INTO drives (id, user_id, name, type, config_data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        ).run("drive-new", "user-dup", "New", "mega", "{}", "active", 2000, 2000);
        const d1 = createD1(db);

        const result = await migrateDatabaseSchema({
            d1,
            useLock: false,
            log: { info: vi.fn(), warn: vi.fn() }
        });

        expect(result.status.isCurrent).toBe(true);
        const rows = db.prepare(
            "SELECT id, status FROM drives WHERE user_id = ? AND type = ? ORDER BY id"
        ).all("user-dup", "mega");
        expect(rows).toEqual([
            { id: "drive-new", status: "active" },
            { id: "drive-old", status: "deleted" }
        ]);

        expect(() => db.prepare(
            "INSERT INTO drives (id, user_id, name, type, config_data, status, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run("drive-third", "user-dup", "Third", "mega", "{}", "active", 0, 3000, 3000)).toThrow();
    });

    test("should fail when an applied migration checksum drifts", async () => {
        db = createLegacyDatabase();
        const d1 = createD1(db);

        await migrateDatabaseSchema({
            d1,
            useLock: false,
            log: { info: vi.fn(), warn: vi.fn() }
        });
        db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = ?").run("bad-checksum", 2);

        const status = await getDatabaseSchemaStatus({ d1 });
        expect(status.isCurrent).toBe(false);
        expect(status.issues).toContain("migration 2:tasks_status_ssot checksum drift");
        await expect(assertDatabaseSchemaCurrent({ d1 })).rejects.toThrow("checksum drift");
    });

    test("should keep historical migration checksums immutable while applying later migrations", async () => {
        db = createDatabaseAppliedThroughVersionFive();
        const d1 = createD1RestCompatible(db);

        const outdatedStatus = await getDatabaseSchemaStatus({ d1 });
        expect(outdatedStatus.isCurrent).toBe(false);
        expect(outdatedStatus.issues).not.toContain("migration 1:initial_schema checksum drift");
        expect(outdatedStatus.missingMigrations).toEqual([
            { version: 7, name: "task_source_metadata" }
        ]);

        const result = await migrateDatabaseSchema({
            d1,
            useLock: false,
            log: { info: vi.fn(), warn: vi.fn() }
        });

        expect(result.results).toContainEqual({
            version: 7,
            name: "task_source_metadata",
            action: "applied",
            executionTimeMs: expect.any(Number)
        });
        expect(result.status.isCurrent).toBe(true);

        const taskColumns = db.prepare("PRAGMA table_info(tasks)").all().map(column => column.name);
        expect(taskColumns).toContain("claim_lease_id");
        expect(taskColumns).toContain("source_type");
        expect(taskColumns).toContain("source_ref");

        const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name);
        expect(indexes).toContain("idx_tasks_claim_lease");

        const migrationOne = db.prepare("SELECT checksum FROM schema_migrations WHERE version = 1").get();
        expect(migrationOne.checksum).toBe("1c71fee80eb09f16419d0143c236c9e7e1d2261f80e8dde4b1c591e5539e5ce9");
    });

    test("should backfill Telegram task source refs when applying source metadata migration", async () => {
        db = createDatabaseAppliedThroughVersionFive();
        db.prepare(
            "INSERT INTO tasks (id, user_id, chat_id, msg_id, source_msg_id, file_name, file_size, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run("telegram-old", "user-1", "chat-42", 101, 100, "old.mp4", 123, "queued", 1, 1);
        const d1 = createD1RestCompatible(db);

        await migrateDatabaseSchema({
            d1,
            useLock: false,
            log: { info: vi.fn(), warn: vi.fn() }
        });

        const row = db.prepare("SELECT source_type, source_ref FROM tasks WHERE id = ?").get("telegram-old");
        expect(row.source_type).toBe("telegram_media");
        expect(JSON.parse(row.source_ref)).toEqual({ chatId: "chat-42", messageId: 100 });
    });

    test("should fail schema assertion before migrations are applied", async () => {
        db = createLegacyDatabase();
        const d1 = createD1(db);

        await expect(assertDatabaseSchemaCurrent({ d1 })).rejects.toThrow("Database schema is not current");
    });

    test("should auto-migrate only when explicitly configured", async () => {
        db = createLegacyDatabase();
        const d1 = createD1(db);
        const log = { info: vi.fn(), warn: vi.fn() };

        await expect(ensureDatabaseSchemaReady({
            d1,
            config: {
                nodeEnv: "prod",
                d1: { accountId: "a", databaseId: "d", token: "t" },
                database: { schemaCheck: true, autoMigrate: false }
            },
            log
        })).rejects.toThrow("Database schema is not current");

        const ready = await ensureDatabaseSchemaReady({
            d1,
            config: {
                nodeEnv: "prod",
                d1: { accountId: "a", databaseId: "d", token: "t" },
                database: { schemaCheck: true, autoMigrate: true }
            },
            log
        });

        expect(ready.status.isCurrent).toBe(true);
    });

    test("should report current status after migrations", async () => {
        db = createLegacyDatabase();
        const d1 = createD1(db);

        await migrateDatabaseSchema({ d1, useLock: false, log: { info: vi.fn(), warn: vi.fn() } });
        const status = await getDatabaseSchemaStatus({ d1 });

        expect(status).toMatchObject({
            currentVersion: LATEST_SCHEMA_VERSION,
            latestVersion: LATEST_SCHEMA_VERSION,
            isCurrent: true
        });
        expect(status.issues).toEqual([]);
        expect(status.missingMigrations).toEqual([]);
    });

    test("should migrate production legacy schema with missing SSOT columns", async () => {
        db = createProductionLegacyDatabase();
        const d1 = createD1RestCompatible(db);

        const result = await migrateDatabaseSchema({
            d1,
            useLock: false,
            log: { info: vi.fn(), warn: vi.fn() }
        });

        expect(result.status.isCurrent).toBe(true);
        expect(result.status.issues).toEqual([]);

        const taskColumns = db.prepare("PRAGMA table_info(tasks)").all().map(column => column.name);
        expect(taskColumns).toContain("claimed_by");
        expect(taskColumns).toContain("claim_lease_id");
        expect(taskColumns).toContain("source_type");
        expect(taskColumns).toContain("source_ref");
        expect(taskColumns).not.toContain("drive_id");

        const migratedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get("task-prod-1");
        expect(migratedTask).toMatchObject({
            user_id: "user-prod",
            chat_id: "chat-prod",
            msg_id: 100,
            source_msg_id: 99,
            file_name: "queued.mp4",
            file_size: 42,
            status: "queued",
            claimed_by: null,
            claim_lease_id: null,
            source_type: "telegram_media",
            created_at: 1000,
            updated_at: 1000
        });
        expect(JSON.parse(migratedTask.source_ref)).toEqual({ chatId: "chat-prod", messageId: 99 });

        const driveColumns = db.prepare("PRAGMA table_info(drives)").all().map(column => column.name);
        expect(driveColumns).toContain("is_default");

        const migratedDrive = db.prepare("SELECT * FROM drives WHERE id = ?").get("1");
        expect(migratedDrive).toMatchObject({
            user_id: "user-prod",
            name: "Mega",
            type: "mega",
            config_data: '{"user":"u"}',
            remote_folder: "/remote",
            status: "active",
            is_default: 0,
            created_at: 900,
            updated_at: 950
        });

        const settingsColumns = db.prepare("PRAGMA table_info(settings)").all().map(column => column.name);
        expect(settingsColumns).toContain("created_at");

        const sessionColumns = db.prepare("PRAGMA table_info(sessions)").all().map(column => column.name);
        expect(sessionColumns).toEqual(["id", "user_id", "data", "created_at", "expires_at"]);

        const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(row => row.name);
        expect(indexes).toContain("idx_tasks_status_updated");
        expect(indexes).toContain("idx_tasks_claim_lease");
        expect(indexes).toContain("idx_drives_one_default_per_user");

        const migrations = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
        expect(migrations.map(row => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
});
