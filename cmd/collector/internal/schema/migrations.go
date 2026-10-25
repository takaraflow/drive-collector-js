package schema

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

// RequiredTableColumns 结构体校验所需的各表字段列表。
var RequiredTableColumns = map[string][]string{
	"schema_migrations": {"version", "name", "checksum", "applied_at"},
	"tasks": {
		"id", "user_id", "chat_id", "msg_id", "source_msg_id", "grouped_id",
		"source_type", "source_ref", "file_name", "file_size", "status",
		"error_msg", "claimed_by", "claim_lease_id", "created_at", "updated_at",
	},
	"drives": {
		"id", "user_id", "name", "type", "config_data", "remote_folder",
		"status", "is_default", "created_at", "updated_at",
	},
	"settings":   {"key", "value", "created_at", "updated_at"},
	"sessions":   {"id", "user_id", "data", "created_at", "expires_at"},
	"api_keys":   {"user_id", "token", "created_at", "updated_at"},
	"user_roles": {"user_id", "role", "created_at", "updated_at"},
}

// RequiredIndexes 必须存在的索引清单。
var RequiredIndexes = []string{
	"idx_tasks_status_updated",
	"idx_tasks_stalled_recovery",
	"idx_tasks_claim_lease",
	"idx_tasks_grouped_id",
	"idx_drives_user_default",
	"idx_drives_one_default_per_user",
	"idx_drives_one_active_type_per_user",
	"idx_api_keys_token",
	"idx_user_roles_role",
}

// MigrationDef 单个版本迁移定义。
type MigrationDef struct {
	Version     int
	Name        string
	Description string
	ShouldRun   func(ctx context.Context, q Queryer) (bool, error)
	Apply       func(ctx context.Context, q Queryer) error
}

// Checksum 计算迁移定义的 SHA256 签名。
func (m *MigrationDef) Checksum() string {
	h := sha256.New()
	h.Write([]byte(fmt.Sprintf("%d:%s:%s", m.Version, m.Name, m.Description)))
	return hex.EncodeToString(h.Sum(nil))
}

// AllMigrations 注册 1 到 11 全部迁移。
func AllMigrations() []MigrationDef {
	return []MigrationDef{
		{
			Version:     1,
			Name:        "initial_schema",
			Description: "create base tables tasks, drives, settings, sessions, api_keys, user_roles and indexes",
			ShouldRun: func(ctx context.Context, q Queryer) (bool, error) {
				return true, nil
			},
			Apply: applyInitialSchema,
		},
		{
			Version:     2,
			Name:        "tasks_status_ssot",
			Description: "ensure tasks table has canonical status CHECK constraint",
			ShouldRun: func(ctx context.Context, q Queryer) (bool, error) {
				sqlStr, err := getTableSql(ctx, q, "tasks")
				if err != nil {
					return false, err
				}
				if sqlStr == "" {
					return false, nil
				}
				return !strings.Contains(normalizeSql(sqlStr), normalizeSql("status IN ('queued', 'downloading', 'downloaded', 'uploading', 'completed', 'failed', 'cancelled')")), nil
			},
			Apply: applyTaskStatusSsot,
		},
		{
			Version:     3,
			Name:        "drives_default_ssot",
			Description: "add drives.is_default and default-drive uniqueness indexes",
			ShouldRun: func(ctx context.Context, q Queryer) (bool, error) {
				hasCol, err := columnExists(ctx, q, "drives", "is_default")
				if err != nil {
					return false, err
				}
				if !hasCol {
					return true, nil
				}
				hasIdx, err := indexExists(ctx, q, "idx_drives_one_default_per_user")
				if err != nil {
					return false, err
				}
				return !hasIdx, nil
			},
			Apply: applyDriveSsot,
		},
		{
			Version:     4,
			Name:        "user_roles_ssot",
			Description: "create user_roles table with canonical role CHECK constraint and index",
			ShouldRun: func(ctx context.Context, q Queryer) (bool, error) {
				tblExists, err := tableExists(ctx, q, "user_roles")
				if err != nil {
					return false, err
				}
				if !tblExists {
					return true, nil
				}
				hasIdx, err := indexExists(ctx, q, "idx_user_roles_role")
				if err != nil {
					return false, err
				}
				return !hasIdx, nil
			},
			Apply: applyUserRolesSsot,
		},
		{
			Version:     5,
			Name:        "drives_active_type_unique_ssot",
			Description: "enforce active-only unique index on (user_id, type) for drives",
			ShouldRun: func(ctx context.Context, q Queryer) (bool, error) {
				hasIdx, err := indexExists(ctx, q, "idx_drives_one_active_type_per_user")
				if err != nil {
					return false, err
				}
				return !hasIdx, nil
			},
			Apply: applyDriveActiveTypeUniqueSsot,
		},
		{
			Version:     6,
			Name:        "task_claim_lease_fencing",
			Description: "add tasks.claim_lease_id and claim owner/lease index for fenced task transitions",
			ShouldRun: func(ctx context.Context, q Queryer) (bool, error) {
				hasCol, err := columnExists(ctx, q, "tasks", "claim_lease_id")
				if err != nil {
					return false, err
				}
				if !hasCol {
					return true, nil
				}
				hasIdx, err := indexExists(ctx, q, "idx_tasks_claim_lease")
				if err != nil {
					return false, err
				}
				return !hasIdx, nil
			},
			Apply: applyTaskClaimLeaseFencing,
		},
		{
			Version:     7,
			Name:        "task_source_metadata",
			Description: "add tasks.source_type and tasks.source_ref for non-Telegram task sources and backfill",
			ShouldRun: func(ctx context.Context, q Queryer) (bool, error) {
				hasType, err := columnExists(ctx, q, "tasks", "source_type")
				if err != nil {
					return false, err
				}
				hasRef, err := columnExists(ctx, q, "tasks", "source_ref")
				if err != nil {
					return false, err
				}
				return !hasType || !hasRef, nil
			},
			Apply: applyTaskSourceMetadata,
		},
		{
			Version:     8,
			Name:        "drive_password_format_ssot",
			Description: "mark legacy rclone password drive configs with explicit unknown password format",
			ShouldRun: func(ctx context.Context, q Queryer) (bool, error) {
				tblExists, err := tableExists(ctx, q, "drives")
				if err != nil || !tblExists {
					return false, err
				}
				row, err := q.FetchOne(ctx, `SELECT id FROM drives 
					WHERE status = 'active' 
					AND type IN ('mega', 'webdav', 's3', 'onedrive', 'box', 'pcloud') 
					AND json_valid(config_data) 
					AND json_extract(config_data, '$.pass') IS NOT NULL 
					AND (json_extract(config_data, '$.pass_format') IS NULL OR json_extract(config_data, '$.config_schema_version') IS NULL) 
					LIMIT 1`)
				if err != nil {
					return false, nil // json_valid 不支持时跳过
				}
				return row != nil, nil
			},
			Apply: applyDrivePasswordFormatSsot,
		},
		{
			Version:     9,
			Name:        "task_stalled_recovery_index",
			Description: "backfill nullable task timestamps and add tasks(status, updated_at, created_at) index",
			ShouldRun: func(ctx context.Context, q Queryer) (bool, error) {
				hasIdx, err := indexExists(ctx, q, "idx_tasks_stalled_recovery")
				if err != nil {
					return false, err
				}
				return !hasIdx, nil
			},
			Apply: applyTaskStalledRecoveryIndex,
		},
		{
			Version:     10,
			Name:        "active_drive_default_backfill",
			Description: "backfill one default drive for users with active drives but no active default",
			ShouldRun: func(ctx context.Context, q Queryer) (bool, error) {
				tblExists, err := tableExists(ctx, q, "drives")
				if err != nil || !tblExists {
					return false, err
				}
				row, err := q.FetchOne(ctx, `SELECT user_id FROM drives 
					WHERE status = 'active' 
					GROUP BY user_id 
					HAVING SUM(CASE WHEN is_default = 1 THEN 1 ELSE 0 END) = 0 
					LIMIT 1`)
				if err != nil {
					return false, nil
				}
				return row != nil, nil
			},
			Apply: applyActiveDriveDefaultBackfill,
		},
		{
			Version:     11,
			Name:        "task_grouped_id",
			Description: "add tasks.grouped_id and index for media group aggregated operations",
			ShouldRun: func(ctx context.Context, q Queryer) (bool, error) {
				hasCol, err := columnExists(ctx, q, "tasks", "grouped_id")
				if err != nil {
					return false, err
				}
				if !hasCol {
					return true, nil
				}
				hasIdx, err := indexExists(ctx, q, "idx_tasks_grouped_id")
				if err != nil {
					return false, err
				}
				return !hasIdx, nil
			},
			Apply: applyTaskGroupedID,
		},
	}
}

// ----------------------------------------------------------------------------
// 各版本执行函数
// ----------------------------------------------------------------------------

func applyInitialSchema(ctx context.Context, q Queryer) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS schema_migrations (
			version INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			checksum TEXT NOT NULL,
			applied_at INTEGER NOT NULL,
			execution_time_ms INTEGER DEFAULT 0
		)`,
		`CREATE TABLE IF NOT EXISTS schema_migration_lock (
			id TEXT PRIMARY KEY,
			owner TEXT NOT NULL,
			expires_at INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS tasks (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			chat_id TEXT,
			msg_id INTEGER,
			source_msg_id INTEGER,
			grouped_id INTEGER,
			source_type TEXT DEFAULT 'telegram_media',
			source_ref TEXT,
			file_name TEXT,
			file_size INTEGER DEFAULT 0,
			status TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'downloading', 'downloaded', 'uploading', 'completed', 'failed', 'cancelled')),
			error_msg TEXT,
			claimed_by TEXT,
			claim_lease_id TEXT,
			created_at INTEGER,
			updated_at INTEGER
		)`,
		"CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_msg_id ON tasks(msg_id)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_claimed_by ON tasks(claimed_by)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_claim_lease ON tasks(claimed_by, claim_lease_id)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_stalled_recovery ON tasks(status, updated_at, created_at)",
		"CREATE INDEX IF NOT EXISTS idx_tasks_grouped_id ON tasks(grouped_id)",

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
			updated_at INTEGER
		)`,
		"CREATE INDEX IF NOT EXISTS idx_drives_user_id ON drives(user_id)",
		"CREATE INDEX IF NOT EXISTS idx_drives_status ON drives(status)",
		"CREATE INDEX IF NOT EXISTS idx_drives_type ON drives(type)",
		"CREATE INDEX IF NOT EXISTS idx_drives_user_status ON drives(user_id, status)",
		"CREATE INDEX IF NOT EXISTS idx_drives_user_default ON drives(user_id, is_default)",
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_drives_one_default_per_user ON drives(user_id) WHERE is_default = 1 AND status = 'active'",
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_drives_one_active_type_per_user ON drives(user_id, type) WHERE status = 'active'",

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
		"CREATE INDEX IF NOT EXISTS idx_api_keys_token ON api_keys(token)",

		`CREATE TABLE IF NOT EXISTS user_roles (
			user_id TEXT PRIMARY KEY,
			role TEXT NOT NULL CHECK (role IN ('banned', 'user', 'trusted', 'admin')),
			created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
			updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
		)`,
		"CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role)",
	}

	return runStatements(ctx, q, statements)
}

func applyTaskStatusSsot(ctx context.Context, q Queryer) error {
	// 确保基础表存在
	if exists, _ := tableExists(ctx, q, "tasks"); !exists {
		return applyInitialSchema(ctx, q)
	}
	// 在 D1/SQLite 中，检查是否已有 canonical 校验约束，如果没有则补齐列
	_, err := addMissingColumns(ctx, q, "tasks", map[string]string{
		"status": "TEXT DEFAULT 'queued' CHECK (status IN ('queued', 'downloading', 'downloaded', 'uploading', 'completed', 'failed', 'cancelled'))",
	})
	return err
}

func applyDriveSsot(ctx context.Context, q Queryer) error {
	if exists, _ := tableExists(ctx, q, "drives"); !exists {
		return applyInitialSchema(ctx, q)
	}
	if hasCol, _ := columnExists(ctx, q, "drives", "is_default"); !hasCol {
		if _, err := q.Exec(ctx, "ALTER TABLE drives ADD COLUMN is_default INTEGER DEFAULT 0 CHECK (is_default IN (0, 1))"); err != nil {
			return err
		}
	}
	return runStatements(ctx, q, []string{
		"CREATE INDEX IF NOT EXISTS idx_drives_user_default ON drives(user_id, is_default)",
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_drives_one_default_per_user ON drives(user_id) WHERE is_default = 1 AND status = 'active'",
	})
}

func applyUserRolesSsot(ctx context.Context, q Queryer) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS user_roles (
			user_id TEXT PRIMARY KEY,
			role TEXT NOT NULL CHECK (role IN ('banned', 'user', 'trusted', 'admin')),
			created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
			updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
		)`,
		"CREATE INDEX IF NOT EXISTS idx_user_roles_role ON user_roles(role)",
	}
	return runStatements(ctx, q, statements)
}

func applyDriveActiveTypeUniqueSsot(ctx context.Context, q Queryer) error {
	_, err := q.Exec(ctx, "CREATE UNIQUE INDEX IF NOT EXISTS idx_drives_one_active_type_per_user ON drives(user_id, type) WHERE status = 'active'")
	return err
}

func applyTaskClaimLeaseFencing(ctx context.Context, q Queryer) error {
	if hasCol, _ := columnExists(ctx, q, "tasks", "claim_lease_id"); !hasCol {
		if _, err := q.Exec(ctx, "ALTER TABLE tasks ADD COLUMN claim_lease_id TEXT"); err != nil {
			return err
		}
	}
	_, err := q.Exec(ctx, "CREATE INDEX IF NOT EXISTS idx_tasks_claim_lease ON tasks(claimed_by, claim_lease_id)")
	return err
}

func applyTaskSourceMetadata(ctx context.Context, q Queryer) error {
	if hasCol, _ := columnExists(ctx, q, "tasks", "source_type"); !hasCol {
		if _, err := q.Exec(ctx, "ALTER TABLE tasks ADD COLUMN source_type TEXT DEFAULT 'telegram_media'"); err != nil {
			return err
		}
	}
	if hasCol, _ := columnExists(ctx, q, "tasks", "source_ref"); !hasCol {
		if _, err := q.Exec(ctx, "ALTER TABLE tasks ADD COLUMN source_ref TEXT"); err != nil {
			return err
		}
	}
	// 回填 telegram_media 的 source_ref
	_, _ = q.Exec(ctx, `UPDATE tasks 
		SET source_ref = '{"chatId":' || json_quote(CAST(chat_id AS TEXT)) || ',"messageId":' || CAST(source_msg_id AS INTEGER) || '}'
		WHERE source_type = 'telegram_media' AND source_ref IS NULL AND chat_id IS NOT NULL AND source_msg_id IS NOT NULL`)
	return nil
}

func applyDrivePasswordFormatSsot(ctx context.Context, q Queryer) error {
	now := time.Now().UnixMilli()
	_, err := q.Exec(ctx, `UPDATE drives 
		SET config_data = json_set(config_data, '$.pass_format', 'legacy_unknown', '$.config_schema_version', 1),
		    updated_at = ?
		WHERE status = 'active'
		  AND type IN ('mega', 'webdav', 's3', 'onedrive', 'box', 'pcloud')
		  AND json_valid(config_data)
		  AND json_extract(config_data, '$.pass') IS NOT NULL
		  AND (json_extract(config_data, '$.pass_format') IS NULL OR json_extract(config_data, '$.config_schema_version') IS NULL)`, now)
	return err
}

func applyTaskStalledRecoveryIndex(ctx context.Context, q Queryer) error {
	now := time.Now().UnixMilli()
	_, _ = q.Exec(ctx, `UPDATE tasks 
		SET created_at = COALESCE(created_at, updated_at, ?),
		    updated_at = COALESCE(updated_at, created_at, ?)
		WHERE created_at IS NULL OR updated_at IS NULL`, now, now)
	_, err := q.Exec(ctx, "CREATE INDEX IF NOT EXISTS idx_tasks_stalled_recovery ON tasks(status, updated_at, created_at)")
	return err
}

func applyActiveDriveDefaultBackfill(ctx context.Context, q Queryer) error {
	now := time.Now().UnixMilli()
	_, err := q.Exec(ctx, `UPDATE drives 
		SET is_default = 1, updated_at = ?
		WHERE status = 'active' AND id IN (
			SELECT selected.id FROM drives selected
			WHERE selected.status = 'active'
			AND NOT EXISTS (
				SELECT 1 FROM drives ex WHERE ex.user_id = selected.user_id AND ex.status = 'active' AND ex.is_default = 1
			)
			GROUP BY selected.user_id
		)`, now)
	return err
}

func applyTaskGroupedID(ctx context.Context, q Queryer) error {
	if hasCol, _ := columnExists(ctx, q, "tasks", "grouped_id"); !hasCol {
		if _, err := q.Exec(ctx, "ALTER TABLE tasks ADD COLUMN grouped_id INTEGER"); err != nil {
			return err
		}
	}
	_, err := q.Exec(ctx, "CREATE INDEX IF NOT EXISTS idx_tasks_grouped_id ON tasks(grouped_id)")
	return err
}

// ----------------------------------------------------------------------------
// SQL 结构辅助函数
// ----------------------------------------------------------------------------

func runStatements(ctx context.Context, q Queryer, statements []string) error {
	for _, stmt := range statements {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}
		if _, err := q.Exec(ctx, stmt); err != nil {
			return fmt.Errorf("执行 SQL 失败 [%s]: %w", stmt, err)
		}
	}
	return nil
}

func tableExists(ctx context.Context, q Queryer, tableName string) (bool, error) {
	row, err := q.FetchOne(ctx, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", tableName)
	if err != nil {
		return false, err
	}
	return row != nil, nil
}

func indexExists(ctx context.Context, q Queryer, indexName string) (bool, error) {
	row, err := q.FetchOne(ctx, "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?", indexName)
	if err != nil {
		return false, err
	}
	return row != nil, nil
}

func getTableSql(ctx context.Context, q Queryer, tableName string) (string, error) {
	row, err := q.FetchOne(ctx, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", tableName)
	if err != nil || row == nil {
		return "", err
	}
	if s, ok := row["sql"].(string); ok {
		return s, nil
	}
	return "", nil
}

func getTableColumns(ctx context.Context, q Queryer, tableName string) ([]string, error) {
	exists, err := tableExists(ctx, q, tableName)
	if err != nil || !exists {
		return nil, err
	}
	rows, err := q.FetchAll(ctx, fmt.Sprintf("PRAGMA table_info(\"%s\")", tableName))
	if err != nil {
		return nil, err
	}
	cols := make([]string, 0, len(rows))
	for _, r := range rows {
		if name, ok := r["name"].(string); ok {
			cols = append(cols, name)
		}
	}
	return cols, nil
}

func columnExists(ctx context.Context, q Queryer, tableName, columnName string) (bool, error) {
	cols, err := getTableColumns(ctx, q, tableName)
	if err != nil {
		return false, err
	}
	for _, c := range cols {
		if c == columnName {
			return true, nil
		}
	}
	return false, nil
}

func addMissingColumns(ctx context.Context, q Queryer, tableName string, colDefs map[string]string) ([]string, error) {
	cols, err := getTableColumns(ctx, q, tableName)
	if err != nil {
		return nil, err
	}
	existingMap := make(map[string]bool, len(cols))
	for _, c := range cols {
		existingMap[c] = true
	}
	for colName, def := range colDefs {
		if !existingMap[colName] {
			sql := fmt.Sprintf("ALTER TABLE \"%s\" ADD COLUMN \"%s\" %s", tableName, colName, def)
			if _, err := q.Exec(ctx, sql); err != nil {
				return nil, fmt.Errorf("添加字段失败: %w", err)
			}
			cols = append(cols, colName)
			existingMap[colName] = true
		}
	}
	return cols, nil
}

func normalizeSql(s string) string {
	fields := strings.Fields(strings.ToLower(s))
	return strings.Join(fields, " ")
}
