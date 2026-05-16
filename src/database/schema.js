import crypto from "crypto";

export const LATEST_SCHEMA_VERSION = 3;

const MIGRATION_LOCK_ID = "database-schema";
const CANONICAL_TASK_STATUS_CHECK = "CHECK (status IN ('queued', 'downloading', 'downloaded', 'uploading', 'completed', 'failed', 'cancelled'))";
const CANONICAL_DRIVE_STATUS_CHECK = "CHECK (status IN ('active', 'deleted'))";
const CANONICAL_TASK_STATUSES = ["queued", "downloading", "downloaded", "uploading", "completed", "failed", "cancelled"];

const TASK_INDEX_STATEMENTS = [
    "CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_msg_id ON tasks(msg_id)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at)"
];

const DRIVE_INDEX_STATEMENTS = [
    "CREATE INDEX IF NOT EXISTS idx_drives_user_id ON drives(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_drives_status ON drives(status)",
    "CREATE INDEX IF NOT EXISTS idx_drives_type ON drives(type)",
    "CREATE INDEX IF NOT EXISTS idx_drives_user_status ON drives(user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_drives_user_default ON drives(user_id, is_default)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_drives_one_default_per_user ON drives(user_id) WHERE is_default = 1 AND status = 'active'"
];

const SESSION_INDEX_STATEMENTS = [
    "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)"
];

const INITIAL_SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS tasks (
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
    )`,
    "CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_msg_id ON tasks(msg_id)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at)",

    `CREATE TABLE IF NOT EXISTS drives (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT,
        type TEXT NOT NULL,
        config_data TEXT NOT NULL,
        remote_folder TEXT,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
        is_default INTEGER DEFAULT 0 CHECK (is_default IN (0, 1)),
        created_at INTEGER,
        updated_at INTEGER,
        UNIQUE(user_id, type)
    )`,
    "CREATE INDEX IF NOT EXISTS idx_drives_user_id ON drives(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_drives_status ON drives(status)",
    "CREATE INDEX IF NOT EXISTS idx_drives_type ON drives(type)",
    "CREATE INDEX IF NOT EXISTS idx_drives_user_status ON drives(user_id, status)",

    `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    )`,

    `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        expires_at INTEGER
    )`,
    "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at)",

    `CREATE TABLE IF NOT EXISTS api_keys (
        user_id TEXT PRIMARY KEY,
        token TEXT UNIQUE NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )`,
    "CREATE INDEX IF NOT EXISTS idx_api_keys_token ON api_keys(token)"
];

const SCHEMA_MIGRATIONS_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    execution_time_ms INTEGER DEFAULT 0
)`;

const SCHEMA_MIGRATION_LOCK_SQL = `CREATE TABLE IF NOT EXISTS schema_migration_lock (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
)`;

const REQUIRED_TABLE_COLUMNS = {
    schema_migrations: ["version", "name", "checksum", "applied_at"],
    tasks: ["id", "user_id", "chat_id", "msg_id", "source_msg_id", "file_name", "file_size", "status", "error_msg", "claimed_by", "created_at", "updated_at"],
    drives: ["id", "user_id", "name", "type", "config_data", "remote_folder", "status", "is_default", "created_at", "updated_at"],
    settings: ["key", "value", "created_at", "updated_at"],
    sessions: ["id", "user_id", "data", "created_at", "expires_at"],
    api_keys: ["user_id", "token", "created_at", "updated_at"]
};

const REQUIRED_INDEXES = [
    "idx_tasks_status_updated",
    "idx_drives_user_default",
    "idx_drives_one_default_per_user",
    "idx_api_keys_token"
];

function normalizeSql(sql = "") {
    return String(sql).replace(/\s+/g, " ").trim();
}

function getCreateTableStatement(tableName) {
    const prefix = normalizeSql(`CREATE TABLE IF NOT EXISTS ${tableName}`);
    const statement = INITIAL_SCHEMA_STATEMENTS.find(item => normalizeSql(item).startsWith(prefix));
    if (!statement) {
        throw new Error(`Missing create-table statement for ${tableName}`);
    }
    return statement;
}

function checksum(value) {
    return crypto.createHash("sha256").update(value).digest("hex");
}

function quoteIdentifier(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid SQL identifier: ${name}`);
    }
    return `"${name}"`;
}

async function tableExists(d1, tableName) {
    const row = await d1.fetchOne(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    return Boolean(row);
}

async function indexExists(d1, indexName) {
    const row = await d1.fetchOne(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        [indexName]
    );
    return Boolean(row);
}

async function getTableSql(d1, tableName) {
    const row = await d1.fetchOne(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        [tableName]
    );
    return row?.sql || "";
}

async function getTableColumns(d1, tableName) {
    if (!(await tableExists(d1, tableName))) return [];
    const columns = await d1.fetchAll(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
    return columns.map(column => column.name);
}

async function columnExists(d1, tableName, columnName) {
    const columns = await getTableColumns(d1, tableName);
    return columns.includes(columnName);
}

async function runStatements(d1, statements) {
    for (const statement of statements) {
        await d1.run(statement);
    }
}

async function ensureMigrationStorage(d1) {
    await d1.run(SCHEMA_MIGRATIONS_SQL);
    await d1.run(SCHEMA_MIGRATION_LOCK_SQL);
}

function literal(value) {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function columnExpression(columns, columnName, fallback) {
    return columns.includes(columnName) ? quoteIdentifier(columnName) : fallback;
}

function coalescedColumnExpression(columns, columnName, fallback) {
    return columns.includes(columnName) ? `COALESCE(${quoteIdentifier(columnName)}, ${fallback})` : fallback;
}

async function addMissingColumns(d1, tableName, columnDefinitions) {
    const columns = await getTableColumns(d1, tableName);
    for (const [columnName, definition] of Object.entries(columnDefinitions)) {
        if (!columns.includes(columnName)) {
            await d1.run(`ALTER TABLE ${quoteIdentifier(tableName)} ADD COLUMN ${quoteIdentifier(columnName)} ${definition}`);
            columns.push(columnName);
        }
    }
    return columns;
}

async function cleanupTableRebuildArtifacts(d1, tableName, temporaryTableName, backupTableName, indexStatements = []) {
    const tablePresent = await tableExists(d1, tableName);
    const temporaryPresent = await tableExists(d1, temporaryTableName);
    const backupPresent = await tableExists(d1, backupTableName);

    if (!tablePresent && temporaryPresent) {
        await d1.run(`ALTER TABLE ${quoteIdentifier(temporaryTableName)} RENAME TO ${quoteIdentifier(tableName)}`);
        if (backupPresent) {
            await d1.run(`DROP TABLE ${quoteIdentifier(backupTableName)}`);
        }
        await runStatements(d1, indexStatements);
        return "promoted-temporary";
    }

    if (!tablePresent && backupPresent) {
        await d1.run(`ALTER TABLE ${quoteIdentifier(backupTableName)} RENAME TO ${quoteIdentifier(tableName)}`);
        return "restored-backup";
    }

    if (tablePresent && backupPresent) {
        await d1.run(`DROP TABLE ${quoteIdentifier(backupTableName)}`);
    }

    if (tablePresent && temporaryPresent) {
        await d1.run(`DROP TABLE ${quoteIdentifier(temporaryTableName)}`);
    }

    return "ready";
}

async function rebuildTableForD1(d1, {
    tableName,
    temporaryTableName,
    backupTableName,
    createTemporaryTableSql,
    insertTemporaryTableSql,
    indexStatements = []
}) {
    const recovery = await cleanupTableRebuildArtifacts(
        d1,
        tableName,
        temporaryTableName,
        backupTableName,
        indexStatements
    );
    if (recovery === "promoted-temporary") return;

    await d1.run(`DROP TABLE IF EXISTS ${quoteIdentifier(temporaryTableName)}`);
    await d1.run(createTemporaryTableSql);
    await d1.run(insertTemporaryTableSql);
    await d1.run(`DROP TABLE IF EXISTS ${quoteIdentifier(backupTableName)}`);
    await d1.run(`ALTER TABLE ${quoteIdentifier(tableName)} RENAME TO ${quoteIdentifier(backupTableName)}`);
    await d1.run(`ALTER TABLE ${quoteIdentifier(temporaryTableName)} RENAME TO ${quoteIdentifier(tableName)}`);
    await d1.run(`DROP TABLE ${quoteIdentifier(backupTableName)}`);
    await runStatements(d1, indexStatements);
}

async function ensureTaskBaseSchema(d1) {
    if (!(await tableExists(d1, "tasks"))) {
        await d1.run(getCreateTableStatement("tasks"));
    } else {
        await addMissingColumns(d1, "tasks", {
            user_id: "TEXT",
            chat_id: "TEXT",
            msg_id: "INTEGER",
            source_msg_id: "INTEGER",
            file_name: "TEXT",
            file_size: "INTEGER DEFAULT 0",
            status: "TEXT DEFAULT 'queued'",
            error_msg: "TEXT",
            claimed_by: "TEXT",
            created_at: "INTEGER",
            updated_at: "INTEGER"
        });
    }

    await runStatements(d1, TASK_INDEX_STATEMENTS);
}

async function ensureDriveBaseSchema(d1) {
    if (!(await tableExists(d1, "drives"))) {
        await d1.run(getCreateTableStatement("drives"));
    } else {
        await addMissingColumns(d1, "drives", {
            user_id: "TEXT",
            name: "TEXT",
            type: "TEXT",
            config_data: "TEXT",
            remote_folder: "TEXT",
            status: "TEXT DEFAULT 'active'",
            is_default: "INTEGER DEFAULT 0",
            created_at: "INTEGER",
            updated_at: "INTEGER"
        });
    }

    await runStatements(d1, DRIVE_INDEX_STATEMENTS);
}

async function ensureSettingsSchema(d1) {
    if (!(await tableExists(d1, "settings"))) {
        await d1.run(getCreateTableStatement("settings"));
        return;
    }

    await addMissingColumns(d1, "settings", {
        value: "TEXT",
        created_at: "INTEGER",
        updated_at: "INTEGER"
    });
    await d1.run("UPDATE settings SET created_at = COALESCE(created_at, updated_at, ?) WHERE created_at IS NULL", [Date.now()]);
    await d1.run("UPDATE settings SET updated_at = COALESCE(updated_at, created_at, ?) WHERE updated_at IS NULL", [Date.now()]);
}

async function ensureSessionsSchema(d1) {
    if (!(await tableExists(d1, "sessions"))) {
        await d1.run(getCreateTableStatement("sessions"));
        await runStatements(d1, SESSION_INDEX_STATEMENTS);
        return;
    }

    const columns = await getTableColumns(d1, "sessions");
    const missingRequiredColumns = REQUIRED_TABLE_COLUMNS.sessions
        .filter(column => !columns.includes(column));

    if (missingRequiredColumns.length > 0) {
        const now = Date.now();
        const idExpr = columns.includes("id")
            ? "CAST(id AS TEXT)"
            : columns.includes("user_id")
                ? "CAST(user_id AS TEXT)"
                : "lower(hex(randomblob(16)))";
        const userIdExpr = columns.includes("user_id")
            ? "CAST(user_id AS TEXT)"
            : columns.includes("id")
                ? "CAST(id AS TEXT)"
                : literal("unknown");
        const dataExpr = columns.includes("data")
            ? `COALESCE(${quoteIdentifier("data")}, ${literal("{}")})`
            : coalescedColumnExpression(columns, "temp_data", literal("{}"));
        const createdAtExpr = coalescedColumnExpression(columns, "created_at",
            coalescedColumnExpression(columns, "updated_at", String(now)));
        const expiresAtExpr = columnExpression(columns, "expires_at", "NULL");
        await rebuildTableForD1(d1, {
            tableName: "sessions",
            temporaryTableName: "sessions_ssot_new",
            backupTableName: "sessions_ssot_backup",
            createTemporaryTableSql: `CREATE TABLE sessions_ssot_new (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
                expires_at INTEGER
            )`,
            insertTemporaryTableSql: `INSERT INTO sessions_ssot_new (id, user_id, data, created_at, expires_at)
            SELECT ${idExpr}, ${userIdExpr}, ${dataExpr}, ${createdAtExpr}, ${expiresAtExpr}
            FROM sessions`,
            indexStatements: SESSION_INDEX_STATEMENTS
        });
    }

    await runStatements(d1, SESSION_INDEX_STATEMENTS);
}

async function ensureApiKeysSchema(d1) {
    if (!(await tableExists(d1, "api_keys"))) {
        await d1.run(getCreateTableStatement("api_keys"));
    } else {
        await addMissingColumns(d1, "api_keys", {
            user_id: "TEXT",
            token: "TEXT",
            created_at: "INTEGER",
            updated_at: "INTEGER"
        });
    }

    await d1.run("CREATE INDEX IF NOT EXISTS idx_api_keys_token ON api_keys(token)");
}

async function applyInitialSchema({ d1 }) {
    await ensureTaskBaseSchema(d1);
    await ensureDriveBaseSchema(d1);
    await ensureSettingsSchema(d1);
    await ensureSessionsSchema(d1);
    await ensureApiKeysSchema(d1);
}

async function applyTaskStatusSsot({ d1 }) {
    const columns = await getTableColumns(d1, "tasks");
    const now = Date.now();
    const statusValues = CANONICAL_TASK_STATUSES.map(literal).join(", ");
    const statusExpr = columns.includes("status")
        ? `CASE
                WHEN status IS NULL THEN 'queued'
                WHEN status IN (${statusValues}) THEN status
                WHEN status IN ('pending', 'waiting') THEN 'queued'
                WHEN status IN ('processing', 'running') THEN 'downloading'
                WHEN status IN ('done', 'success') THEN 'completed'
                WHEN status IN ('error') THEN 'failed'
                ELSE 'failed'
            END`
        : "'queued'";
    const sourceMsgExpr = columns.includes("source_msg_id")
        ? "source_msg_id"
        : columnExpression(columns, "msg_id", "NULL");

    await rebuildTableForD1(d1, {
        tableName: "tasks",
        temporaryTableName: "tasks_ssot_new",
        backupTableName: "tasks_ssot_backup",
        createTemporaryTableSql: `CREATE TABLE tasks_ssot_new (
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
        )`,
        insertTemporaryTableSql: `INSERT INTO tasks_ssot_new (
            id, user_id, chat_id, msg_id, source_msg_id, file_name, file_size,
            status, error_msg, claimed_by, created_at, updated_at
        )
        SELECT
            CAST(${columnExpression(columns, "id", "lower(hex(randomblob(16)))")} AS TEXT),
            CAST(${columnExpression(columns, "user_id", literal("unknown"))} AS TEXT),
            ${columnExpression(columns, "chat_id", "NULL")},
            ${columnExpression(columns, "msg_id", "NULL")},
            ${sourceMsgExpr},
            ${coalescedColumnExpression(columns, "file_name", literal("unknown"))},
            ${coalescedColumnExpression(columns, "file_size", "0")},
            ${statusExpr},
            ${columnExpression(columns, "error_msg", "NULL")},
            ${columnExpression(columns, "claimed_by", "NULL")},
            ${coalescedColumnExpression(columns, "created_at", String(now))},
            ${coalescedColumnExpression(columns, "updated_at", String(now))}
        FROM tasks`,
        indexStatements: TASK_INDEX_STATEMENTS
    });
}

async function applyDriveDefaultSsot({ d1 }) {
    const drivesSql = await getTableSql(d1, "drives");
    const columns = await getTableColumns(d1, "drives");
    const defaultColumnExists = await columnExists(d1, "drives", "is_default");
    const statusCheckMissing = drivesSql !== "" && !normalizeSql(drivesSql).includes(normalizeSql(CANONICAL_DRIVE_STATUS_CHECK));

    if (statusCheckMissing) {
        const defaultSelect = defaultColumnExists
            ? "CASE WHEN is_default = 1 THEN 1 ELSE 0 END"
            : "0";
        const statusExpr = columns.includes("status")
            ? "CASE WHEN status = 'deleted' THEN 'deleted' ELSE 'active' END"
            : "'active'";
        const now = Date.now();

        await rebuildTableForD1(d1, {
            tableName: "drives",
            temporaryTableName: "drives_ssot_new",
            backupTableName: "drives_ssot_backup",
            createTemporaryTableSql: `CREATE TABLE drives_ssot_new (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                name TEXT,
                type TEXT NOT NULL,
                config_data TEXT NOT NULL,
                remote_folder TEXT,
                status TEXT DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
                is_default INTEGER DEFAULT 0 CHECK (is_default IN (0, 1)),
                created_at INTEGER,
                updated_at INTEGER,
                UNIQUE(user_id, type)
            )`,
            insertTemporaryTableSql: `INSERT INTO drives_ssot_new (
                id, user_id, name, type, config_data, remote_folder,
                status, is_default, created_at, updated_at
            )
            SELECT
                CAST(${columnExpression(columns, "id", "lower(hex(randomblob(16)))")} AS TEXT),
                CAST(${columnExpression(columns, "user_id", literal("unknown"))} AS TEXT),
                ${coalescedColumnExpression(columns, "name", literal("Drive"))},
                ${coalescedColumnExpression(columns, "type", literal("unknown"))},
                ${coalescedColumnExpression(columns, "config_data", literal("{}"))},
                ${columnExpression(columns, "remote_folder", "NULL")},
                ${statusExpr},
                ${defaultSelect},
                ${coalescedColumnExpression(columns, "created_at", String(now))},
                ${coalescedColumnExpression(columns, "updated_at",
                    coalescedColumnExpression(columns, "created_at", String(now)))}
            FROM drives`,
            indexStatements: DRIVE_INDEX_STATEMENTS
        });
        return;
    }

    if (!(await columnExists(d1, "drives", "is_default"))) {
        await d1.run("ALTER TABLE drives ADD COLUMN is_default INTEGER DEFAULT 0 CHECK (is_default IN (0, 1))");
    }

    await runStatements(d1, DRIVE_INDEX_STATEMENTS);
}

function getMigrations() {
    return [
        {
            version: 1,
            name: "initial_schema",
            sql: INITIAL_SCHEMA_STATEMENTS.join(";\n") + ";",
            shouldRun: async () => true,
            apply: applyInitialSchema
        },
        {
            version: 2,
            name: "tasks_status_ssot",
            sql: "rebuild tasks table with canonical task status CHECK constraint",
            shouldRun: async ({ d1 }) => {
                const tableSql = await getTableSql(d1, "tasks");
                return tableSql !== "" && !normalizeSql(tableSql).includes(normalizeSql(CANONICAL_TASK_STATUS_CHECK));
            },
            apply: applyTaskStatusSsot
        },
        {
            version: 3,
            name: "drives_default_ssot",
            sql: "add drives.is_default, enforce active/deleted drive status, and add default-drive uniqueness indexes",
            shouldRun: async ({ d1 }) => {
                const drivesSql = await getTableSql(d1, "drives");
                return (drivesSql !== "" && !normalizeSql(drivesSql).includes(normalizeSql(CANONICAL_DRIVE_STATUS_CHECK))) ||
                    !(await columnExists(d1, "drives", "is_default")) ||
                    !(await indexExists(d1, "idx_drives_user_default")) ||
                    !(await indexExists(d1, "idx_drives_one_default_per_user"));
            },
            apply: applyDriveDefaultSsot
        }
    ];
}

async function getAppliedMigrationRows(d1) {
    if (!(await tableExists(d1, "schema_migrations"))) return [];
    return await d1.fetchAll("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version ASC");
}

async function recordMigration(d1, migration, executionTimeMs) {
    await d1.run(
        `INSERT OR IGNORE INTO schema_migrations (version, name, checksum, applied_at, execution_time_ms)
         VALUES (?, ?, ?, ?, ?)`,
        [migration.version, migration.name, checksum(migration.sql), Date.now(), executionTimeMs]
    );
}

async function validateDatabaseStructure(d1) {
    const issues = [];

    for (const [tableName, expectedColumns] of Object.entries(REQUIRED_TABLE_COLUMNS)) {
        if (!(await tableExists(d1, tableName))) {
            issues.push(`missing table: ${tableName}`);
            continue;
        }

        const actualColumns = await getTableColumns(d1, tableName);
        const missingColumns = expectedColumns.filter(column => !actualColumns.includes(column));
        if (missingColumns.length > 0) {
            issues.push(`table ${tableName} missing columns: ${missingColumns.join(", ")}`);
        }
    }

    for (const indexName of REQUIRED_INDEXES) {
        if (!(await indexExists(d1, indexName))) {
            issues.push(`missing index: ${indexName}`);
        }
    }

    const tasksSql = await getTableSql(d1, "tasks");
    if (tasksSql && !normalizeSql(tasksSql).includes(normalizeSql(CANONICAL_TASK_STATUS_CHECK))) {
        issues.push("tasks.status does not enforce canonical task states");
    }

    const drivesSql = await getTableSql(d1, "drives");
    if (drivesSql && !normalizeSql(drivesSql).includes(normalizeSql(CANONICAL_DRIVE_STATUS_CHECK))) {
        issues.push("drives.status does not enforce active/deleted states");
    }

    return issues;
}

async function acquireMigrationLock({ d1, owner, ttlMs, waitMs, pollMs = 1000 }) {
    await d1.run(SCHEMA_MIGRATION_LOCK_SQL);
    const deadline = Date.now() + waitMs;

    while (true) {
        const now = Date.now();
        const expiresAt = now + ttlMs;

        await d1.run(
            "DELETE FROM schema_migration_lock WHERE id = ? AND expires_at < ?",
            [MIGRATION_LOCK_ID, now]
        );
        await d1.run(
            `INSERT OR IGNORE INTO schema_migration_lock (id, owner, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
            [MIGRATION_LOCK_ID, owner, expiresAt, now, now]
        );

        const lock = await d1.fetchOne("SELECT owner FROM schema_migration_lock WHERE id = ?", [MIGRATION_LOCK_ID]);
        if (lock?.owner === owner) return;

        if (Date.now() >= deadline) {
            throw new Error("Database migration lock is held by another process");
        }

        const sleepMs = Math.min(pollMs, Math.max(0, deadline - Date.now()));
        await new Promise(resolve => setTimeout(resolve, sleepMs));
    }
}

async function releaseMigrationLock({ d1, owner }) {
    await d1.run("DELETE FROM schema_migration_lock WHERE id = ? AND owner = ?", [MIGRATION_LOCK_ID, owner]);
}

function createMigrationOwner() {
    return `${process.pid || "pid"}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function getDatabaseSchemaStatus({ d1 } = {}) {
    if (!d1) throw new Error("D1 service is required");

    const migrations = getMigrations();
    const appliedRows = await getAppliedMigrationRows(d1);
    const appliedVersions = new Set(appliedRows.map(row => Number(row.version)));
    const missingMigrations = migrations
        .filter(migration => !appliedVersions.has(migration.version))
        .map(migration => ({ version: migration.version, name: migration.name }));

    const currentVersion = appliedRows.reduce((max, row) => Math.max(max, Number(row.version) || 0), 0);
    const issues = await validateDatabaseStructure(d1);

    return {
        currentVersion,
        latestVersion: LATEST_SCHEMA_VERSION,
        appliedMigrations: appliedRows,
        missingMigrations,
        issues,
        isCurrent: currentVersion >= LATEST_SCHEMA_VERSION && missingMigrations.length === 0 && issues.length === 0
    };
}

export function formatDatabaseSchemaStatus(status) {
    const lines = [
        `schema version: ${status.currentVersion}/${status.latestVersion}`,
        `state: ${status.isCurrent ? "current" : "outdated"}`
    ];

    if (status.missingMigrations.length > 0) {
        lines.push(`missing migrations: ${status.missingMigrations.map(item => `${item.version}:${item.name}`).join(", ")}`);
    }
    if (status.issues.length > 0) {
        lines.push(`schema issues: ${status.issues.join("; ")}`);
    }

    return lines.join("\n");
}

export async function assertDatabaseSchemaCurrent({ d1 } = {}) {
    const status = await getDatabaseSchemaStatus({ d1 });
    if (!status.isCurrent) {
        throw new Error(`Database schema is not current.\n${formatDatabaseSchemaStatus(status)}\nRun "npm run db:migrate" before starting the app.`);
    }
    return status;
}

export async function migrateDatabaseSchema({
    d1,
    log = console,
    dryRun = false,
    useLock = true,
    lockTtlMs = 120000,
    lockWaitMs = 30000
} = {}) {
    if (!d1) throw new Error("D1 service is required");

    const owner = createMigrationOwner();
    if (useLock && !dryRun) {
        await acquireMigrationLock({ d1, owner, ttlMs: lockTtlMs, waitMs: lockWaitMs });
    }

    const results = [];
    try {
        if (!dryRun) {
            await ensureMigrationStorage(d1);
        }
        const appliedRows = await getAppliedMigrationRows(d1);
        const appliedVersions = new Set(appliedRows.map(row => Number(row.version)));

        for (const migration of getMigrations()) {
            if (appliedVersions.has(migration.version)) {
                results.push({ version: migration.version, name: migration.name, action: "already_applied" });
                continue;
            }

            const shouldRun = await migration.shouldRun({ d1 });
            if (dryRun) {
                results.push({
                    version: migration.version,
                    name: migration.name,
                    action: shouldRun ? "would_apply" : "would_record"
                });
                continue;
            }

            const startedAt = Date.now();
            if (shouldRun) {
                log.info?.(`Applying database migration ${migration.version}:${migration.name}`);
                await migration.apply({ d1 });
            } else {
                log.info?.(`Recording satisfied database migration ${migration.version}:${migration.name}`);
            }

            const executionTimeMs = Date.now() - startedAt;
            await recordMigration(d1, migration, executionTimeMs);
            results.push({
                version: migration.version,
                name: migration.name,
                action: shouldRun ? "applied" : "recorded",
                executionTimeMs
            });
        }

        if (dryRun) {
            return { dryRun: true, results };
        }

        const status = await assertDatabaseSchemaCurrent({ d1 });
        return { dryRun: false, results, status };
    } finally {
        if (useLock && !dryRun) {
            await releaseMigrationLock({ d1, owner }).catch(error => {
                log.warn?.(`Failed to release database migration lock: ${error.message}`);
            });
        }
    }
}

function isD1Configured(config = {}) {
    return Boolean(config?.accountId && config?.databaseId && config?.token);
}

export async function ensureDatabaseSchemaReady({ d1, config = {}, log = console } = {}) {
    const databaseConfig = config.database || {};

    if (databaseConfig.schemaCheck === false) {
        log.warn?.("Database schema check skipped by DB_SCHEMA_CHECK=false");
        return { skipped: true, reason: "disabled" };
    }

    if (config.nodeEnv === "test" && databaseConfig.schemaCheck !== true) {
        return { skipped: true, reason: "test-env" };
    }

    if (!isD1Configured(config.d1)) {
        log.warn?.("Database schema check skipped because D1 is not fully configured");
        return { skipped: true, reason: "d1-not-configured" };
    }

    if (databaseConfig.autoMigrate === true) {
        return await migrateDatabaseSchema({
            d1,
            log,
            lockTtlMs: databaseConfig.migrationLockTtlMs,
            lockWaitMs: databaseConfig.migrationLockWaitMs
        });
    }

    const status = await assertDatabaseSchemaCurrent({ d1 });
    log.info?.(`Database schema current at version ${status.currentVersion}`);
    return { skipped: false, status };
}
