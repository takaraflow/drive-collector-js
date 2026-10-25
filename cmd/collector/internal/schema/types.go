package schema

import (
	"context"
	"log/slog"
	"time"
)

// LatestSchemaVersion 是当前系统定义的最高 Schema 版本。
const LatestSchemaVersion = 11

// Queryer 是执行 D1/SQLite 操作的最小接口。
type Queryer interface {
	FetchAll(ctx context.Context, sql string, params ...interface{}) ([]map[string]interface{}, error)
	FetchOne(ctx context.Context, sql string, params ...interface{}) (map[string]interface{}, error)
	Exec(ctx context.Context, sql string, params ...interface{}) (int64, error)
	Execute(ctx context.Context, sql string, params ...interface{}) ([]map[string]interface{}, error)
}

// MigrationRecord 数据库中已记录的迁移行。
type MigrationRecord struct {
	Version         int    `json:"version"`
	Name            string `json:"name"`
	Checksum        string `json:"checksum"`
	AppliedAt       int64  `json:"applied_at"`
	ExecutionTimeMs int64  `json:"execution_time_ms"`
}

// MigrationItem 待迁移项元数据。
type MigrationItem struct {
	Version     int    `json:"version"`
	Name        string `json:"name"`
	Description string `json:"description"`
}

// Status 数据库 Schema 状态。
type Status struct {
	CurrentVersion    int               `json:"current_version"`
	LatestVersion     int               `json:"latest_version"`
	AppliedMigrations []MigrationRecord `json:"applied_migrations"`
	MissingMigrations []MigrationItem   `json:"missing_migrations"`
	Issues            []string          `json:"issues"`
	IsCurrent         bool              `json:"is_current"`
}

// MigrateOptions 迁移控制参数。
type MigrateOptions struct {
	DryRun   bool
	UseLock  bool
	LockTTL  time.Duration
	LockWait time.Duration
	Log      *slog.Logger
}

// MigrationStepResult 单步迁移执行结果。
type MigrationStepResult struct {
	Version         int    `json:"version"`
	Name            string `json:"name"`
	Action          string `json:"action"` // "applied", "already_applied", "skipped_dry_run"
	ExecutionTimeMs int64  `json:"execution_time_ms"`
}

// MigrateResult 完整迁移结果汇总。
type MigrateResult struct {
	Results []MigrationStepResult `json:"results"`
	Status  *Status               `json:"status"`
}
