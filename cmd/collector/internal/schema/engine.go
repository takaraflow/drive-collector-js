package schema

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"
)

const (
	migrationLockID = "database-schema"
	defaultLockTTL  = 2 * time.Minute
	defaultLockWait = 30 * time.Second
)

// GetStatus 查询当前数据库的迁移版本、待迁移版本以及表结构健康度。
func GetStatus(ctx context.Context, q Queryer) (*Status, error) {
	if q == nil {
		return nil, fmt.Errorf("schema: queryer 不能为空")
	}

	all := AllMigrations()
	appliedRows, err := getAppliedMigrations(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("读取迁移历史失败: %w", err)
	}

	appliedMap := make(map[int]MigrationRecord, len(appliedRows))
	currentVersion := 0
	for _, row := range appliedRows {
		appliedMap[row.Version] = row
		if row.Version > currentVersion {
			currentVersion = row.Version
		}
	}

	var missing []MigrationItem
	for _, m := range all {
		if _, ok := appliedMap[m.Version]; !ok {
			missing = append(missing, MigrationItem{
				Version:     m.Version,
				Name:        m.Name,
				Description: m.Description,
			})
		}
	}

	issues, err := validateDatabaseStructure(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("校验表结构完整性失败: %w", err)
	}

	isCurrent := currentVersion >= LatestSchemaVersion && len(missing) == 0 && len(issues) == 0

	return &Status{
		CurrentVersion:    currentVersion,
		LatestVersion:     LatestSchemaVersion,
		AppliedMigrations: appliedRows,
		MissingMigrations: missing,
		Issues:            issues,
		IsCurrent:         isCurrent,
	}, nil
}

// FormatStatus 将 Status 转为易读的多行文本输出。
func FormatStatus(status *Status) string {
	if status == nil {
		return "status: nil"
	}
	state := "outdated"
	if status.IsCurrent {
		state = "current"
	}

	lines := []string{
		fmt.Sprintf("schema version: %d/%d", status.CurrentVersion, status.LatestVersion),
		fmt.Sprintf("state: %s", state),
	}

	if len(status.MissingMigrations) > 0 {
		var missingParts []string
		for _, m := range status.MissingMigrations {
			missingParts = append(missingParts, fmt.Sprintf("%d:%s", m.Version, m.Name))
		}
		lines = append(lines, fmt.Sprintf("missing migrations: %s", strings.Join(missingParts, ", ")))
	}

	if len(status.Issues) > 0 {
		lines = append(lines, fmt.Sprintf("schema issues: %s", strings.Join(status.Issues, "; ")))
	}

	return strings.Join(lines, "\n")
}

// AssertCurrent 校验数据库是否处于最新可用状态，不是则报错。
func AssertCurrent(ctx context.Context, q Queryer) (*Status, error) {
	status, err := GetStatus(ctx, q)
	if err != nil {
		return nil, err
	}
	if !status.IsCurrent {
		return status, fmt.Errorf("数据库 Schema 不是最新状态:\n%s\n请先执行 collector db migrate", FormatStatus(status))
	}
	return status, nil
}

// Migrate 执行数据库 Schema 迁移。
func Migrate(ctx context.Context, q Queryer, opts MigrateOptions) (*MigrateResult, error) {
	if q == nil {
		return nil, fmt.Errorf("schema: queryer 不能为空")
	}

	logger := opts.Log
	if logger == nil {
		logger = slog.Default()
	}

	// 1. 确保迁移元数据表存在
	if err := ensureMigrationStorage(ctx, q); err != nil {
		return nil, fmt.Errorf("初始化迁移元数据表失败: %w", err)
	}

	// 2. 分布式锁防护
	if opts.UseLock && !opts.DryRun {
		owner := createMigrationOwner()
		lockTTL := opts.LockTTL
		if lockTTL <= 0 {
			lockTTL = defaultLockTTL
		}
		lockWait := opts.LockWait
		if lockWait <= 0 {
			lockWait = defaultLockWait
		}

		if err := acquireMigrationLock(ctx, q, owner, lockTTL, lockWait); err != nil {
			return nil, fmt.Errorf("获取数据库迁移锁失败: %w", err)
		}
		defer func() {
			_ = releaseMigrationLock(context.Background(), q, owner)
		}()
	}

	// 3. 读取已应用记录
	appliedRows, err := getAppliedMigrations(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("读取已应用迁移失败: %w", err)
	}
	appliedMap := make(map[int]MigrationRecord, len(appliedRows))
	for _, row := range appliedRows {
		appliedMap[row.Version] = row
	}

	all := AllMigrations()
	var results []MigrationStepResult

	// 4. 依次执行迁移
	for _, m := range all {
		if _, ok := appliedMap[m.Version]; ok {
			results = append(results, MigrationStepResult{
				Version: m.Version,
				Name:    m.Name,
				Action:  "already_applied",
			})
			continue
		}

		if opts.DryRun {
			logger.Info("[dry-run] 发现待执行迁移", "version", m.Version, "name", m.Name)
			results = append(results, MigrationStepResult{
				Version: m.Version,
				Name:    m.Name,
				Action:  "skipped_dry_run",
			})
			continue
		}

		logger.Info("开始执行数据库迁移", "version", m.Version, "name", m.Name)
		start := time.Now()

		if err := m.Apply(ctx, q); err != nil {
			return &MigrateResult{Results: results}, fmt.Errorf("迁移 %d:%s 失败: %w", m.Version, m.Name, err)
		}

		execMs := time.Since(start).Milliseconds()
		nowMs := time.Now().UnixMilli()

		_, err := q.Exec(ctx, `INSERT OR REPLACE INTO schema_migrations 
			(version, name, checksum, applied_at, execution_time_ms) 
			VALUES (?, ?, ?, ?, ?)`, m.Version, m.Name, m.Checksum(), nowMs, execMs)
		if err != nil {
			return &MigrateResult{Results: results}, fmt.Errorf("记录迁移结果失败 %d:%s: %w", m.Version, m.Name, err)
		}

		logger.Info("数据库迁移成功", "version", m.Version, "name", m.Name, "durationMs", execMs)
		results = append(results, MigrationStepResult{
			Version:         m.Version,
			Name:            m.Name,
			Action:          "applied",
			ExecutionTimeMs: execMs,
		})
	}

	finalStatus, err := GetStatus(ctx, q)
	if err != nil {
		return &MigrateResult{Results: results}, err
	}

	return &MigrateResult{
		Results: results,
		Status:  finalStatus,
	}, nil
}

// ----------------------------------------------------------------------------
// 内部辅助
// ----------------------------------------------------------------------------

func ensureMigrationStorage(ctx context.Context, q Queryer) error {
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
	}
	return runStatements(ctx, q, statements)
}

func getAppliedMigrations(ctx context.Context, q Queryer) ([]MigrationRecord, error) {
	exists, err := tableExists(ctx, q, "schema_migrations")
	if err != nil || !exists {
		return nil, err
	}

	rows, err := q.FetchAll(ctx, "SELECT version, name, checksum, applied_at, execution_time_ms FROM schema_migrations ORDER BY version ASC")
	if err != nil {
		return nil, err
	}

	var records []MigrationRecord
	for _, r := range rows {
		rec := MigrationRecord{}
		if v, ok := r["version"].(float64); ok {
			rec.Version = int(v)
		} else if v, ok := r["version"].(int64); ok {
			rec.Version = int(v)
		} else if v, ok := r["version"].(int); ok {
			rec.Version = v
		}

		if n, ok := r["name"].(string); ok {
			rec.Name = n
		}
		if c, ok := r["checksum"].(string); ok {
			rec.Checksum = c
		}
		if a, ok := r["applied_at"].(float64); ok {
			rec.AppliedAt = int64(a)
		} else if a, ok := r["applied_at"].(int64); ok {
			rec.AppliedAt = a
		}
		if e, ok := r["execution_time_ms"].(float64); ok {
			rec.ExecutionTimeMs = int64(e)
		} else if e, ok := r["execution_time_ms"].(int64); ok {
			rec.ExecutionTimeMs = e
		}

		records = append(records, rec)
	}

	return records, nil
}

func validateDatabaseStructure(ctx context.Context, q Queryer) ([]string, error) {
	var issues []string

	for tbl, requiredCols := range RequiredTableColumns {
		exists, err := tableExists(ctx, q, tbl)
		if err != nil {
			return nil, err
		}
		if !exists {
			issues = append(issues, fmt.Sprintf("缺少必需数据表: %s", tbl))
			continue
		}
		cols, err := getTableColumns(ctx, q, tbl)
		if err != nil {
			return nil, err
		}
		colMap := make(map[string]bool, len(cols))
		for _, c := range cols {
			colMap[c] = true
		}
		for _, req := range requiredCols {
			if !colMap[req] {
				issues = append(issues, fmt.Sprintf("数据表 %s 缺少字段: %s", tbl, req))
			}
		}
	}

	for _, idx := range RequiredIndexes {
		exists, err := indexExists(ctx, q, idx)
		if err != nil {
			return nil, err
		}
		if !exists {
			issues = append(issues, fmt.Sprintf("缺少必需索引: %s", idx))
		}
	}

	return issues, nil
}

func createMigrationOwner() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return fmt.Sprintf("collector-go-%d-%d-%s", os.Getpid(), time.Now().UnixMilli(), hex.EncodeToString(b))
}

func acquireMigrationLock(ctx context.Context, q Queryer, owner string, ttl, wait time.Duration) error {
	deadline := time.Now().Add(wait)
	pollInterval := 500 * time.Millisecond

	for {
		now := time.Now().UnixMilli()
		expiresAt := now + ttl.Milliseconds()

		// 1. 清理过期锁
		_, _ = q.Exec(ctx, "DELETE FROM schema_migration_lock WHERE id = ? AND expires_at < ?", migrationLockID, now)

		// 2. 尝试抢锁
		_, _ = q.Exec(ctx, `INSERT OR IGNORE INTO schema_migration_lock 
			(id, owner, expires_at, created_at, updated_at) 
			VALUES (?, ?, ?, ?, ?)`, migrationLockID, owner, expiresAt, now, now)

		// 3. 检查持有者
		row, err := q.FetchOne(ctx, "SELECT owner FROM schema_migration_lock WHERE id = ?", migrationLockID)
		if err == nil && row != nil {
			if curOwner, ok := row["owner"].(string); ok && curOwner == owner {
				return nil
			}
		}

		if time.Now().After(deadline) {
			return fmt.Errorf("等待迁移锁超时 (当前被其他进程持有)")
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollInterval):
		}
	}
}

func releaseMigrationLock(ctx context.Context, q Queryer, owner string) error {
	_, err := q.Exec(ctx, "DELETE FROM schema_migration_lock WHERE id = ? AND owner = ?", migrationLockID, owner)
	return err
}
