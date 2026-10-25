package schema

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeD1Queryer 是纯内存模拟 D1/SQLite 操作的 Mock 实现。
type fakeD1Queryer struct {
	mu          sync.Mutex
	tables      map[string][]string // tableName -> []columnName
	indexes     map[string]bool     // indexName -> bool
	tableSql    map[string]string   // tableName -> CREATE TABLE sql
	migrations  []MigrationRecord
	locks       map[string]mockLock
	execHistory []string
}

type mockLock struct {
	owner     string
	expiresAt int64
}

func newFakeD1Queryer() *fakeD1Queryer {
	return &fakeD1Queryer{
		tables:   make(map[string][]string),
		indexes:  make(map[string]bool),
		tableSql: make(map[string]string),
		locks:    make(map[string]mockLock),
	}
}

func (f *fakeD1Queryer) Execute(ctx context.Context, sql string, params ...interface{}) ([]map[string]interface{}, error) {
	return f.FetchAll(ctx, sql, params...)
}

func (f *fakeD1Queryer) FetchAll(ctx context.Context, sql string, params ...interface{}) ([]map[string]interface{}, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	clean := strings.TrimSpace(sql)

	// 1. sqlite_master 查询表名
	if strings.Contains(clean, "FROM sqlite_master WHERE type = 'table' AND name = ?") {
		if len(params) > 0 {
			tbl := fmt.Sprint(params[0])
			if _, ok := f.tables[tbl]; ok {
				return []map[string]interface{}{{"name": tbl}}, nil
			}
		}
		return nil, nil
	}

	// 2. sqlite_master 查询索引名
	if strings.Contains(clean, "FROM sqlite_master WHERE type = 'index' AND name = ?") {
		if len(params) > 0 {
			idx := fmt.Sprint(params[0])
			if f.indexes[idx] {
				return []map[string]interface{}{{"name": idx}}, nil
			}
		}
		return nil, nil
	}

	// 3. sqlite_master 查询建表 SQL
	if strings.Contains(clean, "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?") {
		if len(params) > 0 {
			tbl := fmt.Sprint(params[0])
			if sqlStr, ok := f.tableSql[tbl]; ok {
				return []map[string]interface{}{{"sql": sqlStr}}, nil
			}
		}
		return nil, nil
	}

	// 4. PRAGMA table_info("table")
	if strings.HasPrefix(clean, "PRAGMA table_info(") {
		tbl := strings.TrimSuffix(strings.TrimPrefix(clean, "PRAGMA table_info(\""), "\")")
		cols, ok := f.tables[tbl]
		if !ok {
			return nil, nil
		}
		var res []map[string]interface{}
		for _, col := range cols {
			res = append(res, map[string]interface{}{"name": col})
		}
		return res, nil
	}

	// 5. SELECT FROM schema_migrations
	if strings.Contains(clean, "FROM schema_migrations") {
		var res []map[string]interface{}
		for _, m := range f.migrations {
			res = append(res, map[string]interface{}{
				"version":           int64(m.Version),
				"name":              m.Name,
				"checksum":          m.Checksum,
				"applied_at":        m.AppliedAt,
				"execution_time_ms": m.ExecutionTimeMs,
			})
		}
		return res, nil
	}

	// 6. SELECT owner FROM schema_migration_lock
	if strings.Contains(clean, "FROM schema_migration_lock WHERE id = ?") {
		if len(params) > 0 {
			lockID := fmt.Sprint(params[0])
			if lk, ok := f.locks[lockID]; ok {
				return []map[string]interface{}{{"owner": lk.owner}}, nil
			}
		}
		return nil, nil
	}

	return nil, nil
}

func (f *fakeD1Queryer) FetchOne(ctx context.Context, sql string, params ...interface{}) (map[string]interface{}, error) {
	rows, err := f.FetchAll(ctx, sql, params...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

func (f *fakeD1Queryer) Exec(ctx context.Context, sql string, params ...interface{}) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	clean := strings.TrimSpace(sql)
	f.execHistory = append(f.execHistory, clean)

	// 1. CREATE TABLE
	if strings.HasPrefix(strings.ToUpper(clean), "CREATE TABLE") {
		tbl := extractTableName(clean)
		if tbl != "" {
			cols := extractTableColumns(clean)
			f.tables[tbl] = cols
			f.tableSql[tbl] = clean
		}
		return 1, nil
	}

	// 2. CREATE INDEX
	if strings.HasPrefix(strings.ToUpper(clean), "CREATE INDEX") || strings.HasPrefix(strings.ToUpper(clean), "CREATE UNIQUE INDEX") {
		idx := extractIndexName(clean)
		if idx != "" {
			f.indexes[idx] = true
		}
		return 1, nil
	}

	// 3. ALTER TABLE ... ADD COLUMN
	if strings.HasPrefix(strings.ToUpper(clean), "ALTER TABLE") && strings.Contains(strings.ToUpper(clean), "ADD COLUMN") {
		tbl, col := extractAlterTableColumn(clean)
		if tbl != "" && col != "" {
			f.tables[tbl] = append(f.tables[tbl], col)
		}
		return 1, nil
	}

	// 4. INSERT OR REPLACE INTO schema_migrations
	if strings.Contains(clean, "INTO schema_migrations") {
		if len(params) >= 5 {
			v := 0
			if val, ok := params[0].(int); ok {
				v = val
			}
			f.migrations = append(f.migrations, MigrationRecord{
				Version:         v,
				Name:            fmt.Sprint(params[1]),
				Checksum:        fmt.Sprint(params[2]),
				AppliedAt:       params[3].(int64),
				ExecutionTimeMs: params[4].(int64),
			})
		}
		return 1, nil
	}

	// 5. schema_migration_lock
	if strings.Contains(clean, "DELETE FROM schema_migration_lock WHERE id = ? AND expires_at < ?") {
		if len(params) >= 2 {
			lockID := fmt.Sprint(params[0])
			now := params[1].(int64)
			if lk, ok := f.locks[lockID]; ok && lk.expiresAt < now {
				delete(f.locks, lockID)
			}
		}
		return 1, nil
	}

	if strings.Contains(clean, "INSERT OR IGNORE INTO schema_migration_lock") {
		if len(params) >= 3 {
			lockID := fmt.Sprint(params[0])
			owner := fmt.Sprint(params[1])
			exp := params[2].(int64)
			if _, ok := f.locks[lockID]; !ok {
				f.locks[lockID] = mockLock{owner: owner, expiresAt: exp}
			}
		}
		return 1, nil
	}

	if strings.Contains(clean, "DELETE FROM schema_migration_lock WHERE id = ? AND owner = ?") {
		if len(params) >= 2 {
			lockID := fmt.Sprint(params[0])
			owner := fmt.Sprint(params[1])
			if lk, ok := f.locks[lockID]; ok && lk.owner == owner {
				delete(f.locks, lockID)
			}
		}
		return 1, nil
	}

	return 1, nil
}

// 辅助解析器
func extractTableName(sql string) string {
	parts := strings.Fields(sql)
	for i, p := range parts {
		if strings.EqualFold(p, "TABLE") && i+1 < len(parts) {
			name := parts[i+1]
			if strings.EqualFold(name, "IF") && i+4 < len(parts) {
				name = parts[i+4]
			}
			name = strings.Trim(name, `()",;`)
			return name
		}
	}
	return ""
}

func extractIndexName(sql string) string {
	parts := strings.Fields(sql)
	for i, p := range parts {
		if strings.EqualFold(p, "INDEX") && i+1 < len(parts) {
			name := parts[i+1]
			if strings.EqualFold(name, "IF") && i+4 < len(parts) {
				name = parts[i+4]
			}
			name = strings.Trim(name, `()",;`)
			return name
		}
	}
	return ""
}

func extractAlterTableColumn(sql string) (string, string) {
	parts := strings.Fields(sql)
	var tbl, col string
	for i, p := range parts {
		if strings.EqualFold(p, "TABLE") && i+1 < len(parts) {
			tbl = strings.Trim(parts[i+1], `()"`)
		}
		if strings.EqualFold(p, "COLUMN") && i+1 < len(parts) {
			col = strings.Trim(parts[i+1], `()"`)
		}
	}
	return tbl, col
}

func extractTableColumns(sql string) []string {
	start := strings.Index(sql, "(")
	end := strings.LastIndex(sql, ")")
	if start == -1 || end == -1 || end <= start {
		return nil
	}
	body := sql[start+1 : end]
	lines := strings.Split(body, "\n")
	var cols []string
	for _, l := range lines {
		l = strings.TrimSpace(l)
		l = strings.TrimSuffix(l, ",")
		if l == "" {
			continue
		}
		upper := strings.ToUpper(l)
		if strings.HasPrefix(upper, "PRIMARY") ||
			strings.HasPrefix(upper, "FOREIGN") ||
			strings.HasPrefix(upper, "UNIQUE") ||
			strings.HasPrefix(upper, "CHECK ") || strings.HasPrefix(upper, "CHECK(") {
			continue
		}
		f := strings.Fields(l)
		if len(f) > 0 {
			name := strings.Trim(f[0], `()"`)
			cols = append(cols, name)
		}
	}
	return cols
}

// ----------------------------------------------------------------------------
// 单元测试
// ----------------------------------------------------------------------------

func TestGetStatus_FreshDatabase(t *testing.T) {
	ctx := context.Background()
	q := newFakeD1Queryer()

	status, err := GetStatus(ctx, q)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if status.CurrentVersion != 0 {
		t.Errorf("expected current version 0, got %d", status.CurrentVersion)
	}
	if status.LatestVersion != LatestSchemaVersion {
		t.Errorf("expected latest version %d, got %d", LatestSchemaVersion, status.LatestVersion)
	}
	if len(status.MissingMigrations) != 11 {
		t.Errorf("expected 11 missing migrations, got %d", len(status.MissingMigrations))
	}
	if status.IsCurrent {
		t.Error("fresh database should not be current")
	}
	if len(status.Issues) == 0 {
		t.Error("fresh database should have missing table issues")
	}
}

func TestMigrate_DryRun(t *testing.T) {
	ctx := context.Background()
	q := newFakeD1Queryer()

	res, err := Migrate(ctx, q, MigrateOptions{DryRun: true})
	if err != nil {
		t.Fatalf("Migrate failed: %v", err)
	}

	if len(res.Results) != 11 {
		t.Fatalf("expected 11 results, got %d", len(res.Results))
	}
	for _, r := range res.Results {
		if r.Action != "skipped_dry_run" {
			t.Errorf("expected action skipped_dry_run, got %s for version %d", r.Action, r.Version)
		}
	}

	// 确认 dry run 未写 migrations 表
	if len(q.migrations) != 0 {
		t.Fatalf("dry run should not persist migrations, got %d", len(q.migrations))
	}
}

func TestMigrate_FullRun_And_Idempotency(t *testing.T) {
	ctx := context.Background()
	q := newFakeD1Queryer()

	// 1. 首次全量迁移
	res, err := Migrate(ctx, q, MigrateOptions{
		UseLock:  true,
		LockTTL:  10 * time.Second,
		LockWait: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("Migrate failed: %v", err)
	}

	if len(res.Results) != 11 {
		t.Fatalf("expected 11 step results, got %d", len(res.Results))
	}
	for _, r := range res.Results {
		if r.Action != "applied" {
			t.Errorf("expected action applied, got %s for version %d", r.Action, r.Version)
		}
	}

	if res.Status == nil || !res.Status.IsCurrent {
		t.Fatalf("expected final status to be current, got: %+v", res.Status)
	}
	if res.Status.CurrentVersion != 11 {
		t.Errorf("expected current version 11, got %d", res.Status.CurrentVersion)
	}
	if len(res.Status.MissingMigrations) != 0 {
		t.Errorf("expected 0 missing migrations, got %d", len(res.Status.MissingMigrations))
	}

	// 校验锁已被释放
	if len(q.locks) != 0 {
		t.Errorf("migration lock should be released, got %d active locks", len(q.locks))
	}

	// 2. 结构断言验证
	status, err := AssertCurrent(ctx, q)
	if err != nil {
		t.Fatalf("AssertCurrent failed on up-to-date db: %v", err)
	}
	if !status.IsCurrent {
		t.Error("expected status to be current")
	}

	// 3. 幂等性测试：再次运行迁移
	res2, err := Migrate(ctx, q, MigrateOptions{UseLock: true})
	if err != nil {
		t.Fatalf("second Migrate failed: %v", err)
	}
	for _, r := range res2.Results {
		if r.Action != "already_applied" {
			t.Errorf("expected action already_applied, got %s for version %d", r.Action, r.Version)
		}
	}
}

func TestFormatStatus(t *testing.T) {
	status := &Status{
		CurrentVersion: 5,
		LatestVersion:  11,
		IsCurrent:      false,
		MissingMigrations: []MigrationItem{
			{Version: 6, Name: "task_claim_lease_fencing"},
			{Version: 7, Name: "task_source_metadata"},
		},
		Issues: []string{"缺少必需索引: idx_tasks_grouped_id"},
	}

	text := FormatStatus(status)
	if !strings.Contains(text, "schema version: 5/11") {
		t.Errorf("expected version 5/11, got:\n%s", text)
	}
	if !strings.Contains(text, "state: outdated") {
		t.Errorf("expected outdated state, got:\n%s", text)
	}
	if !strings.Contains(text, "6:task_claim_lease_fencing") {
		t.Errorf("expected missing migration 6, got:\n%s", text)
	}
	if !strings.Contains(text, "idx_tasks_grouped_id") {
		t.Errorf("expected issue mentioned, got:\n%s", text)
	}
}

func TestMigrationLockContentionAndExpiredCleanup(t *testing.T) {
	ctx := context.Background()
	q := newFakeD1Queryer()

	// 预设一个已过期的锁
	now := time.Now().UnixMilli()
	q.locks[migrationLockID] = mockLock{
		owner:     "stale-owner-process",
		expiresAt: now - 5000, // 5秒前已过期
	}

	// 抢锁应该清理过期锁并成功获得锁
	err := acquireMigrationLock(ctx, q, "new-process", 5*time.Second, 1*time.Second)
	if err != nil {
		t.Fatalf("expected to acquire lock by cleaning expired lock, got: %v", err)
	}

	if q.locks[migrationLockID].owner != "new-process" {
		t.Errorf("expected new-process to hold lock, got: %s", q.locks[migrationLockID].owner)
	}

	// 释放锁
	err = releaseMigrationLock(ctx, q, "new-process")
	if err != nil {
		t.Fatalf("release lock failed: %v", err)
	}
	if _, ok := q.locks[migrationLockID]; ok {
		t.Error("lock should be deleted after release")
	}
}
