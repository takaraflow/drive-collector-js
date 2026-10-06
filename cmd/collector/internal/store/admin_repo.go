package store

// 管理看板的查询 —— /task_queue、/users、/diagnosis 与开关服务模式。
//
// 与 JS 侧 TaskRepository.getQueueOverview / getTasksByStatus 与
// UserRepository.listForAdmin 逐条对齐:同样的 SQL、同样的分页语义。
// 对齐不是为了好看,是因为切换期两边可能同时在跑,管理员看到的
// 「有 3 个失败任务」必须是同一个 3。

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// activeStatusSQL 与 JS 侧 TaskRepository.ACTIVE_STATUS_SQL 一致。
const activeStatusSQL = `'queued','downloading','downloaded','uploading'`

// QueueOverview 是 /task_queue 的三段数据。
type QueueOverview struct {
	// StatusCounts 各状态任务数。
	StatusCounts map[string]int
	// ActiveTasks 活跃任务,按更新时间倒序。
	ActiveTasks []Task
	// UserCounts 活跃任务最多的几个用户(降序)。
	UserCounts []UserTaskCount
}

// UserTaskCount 是「某用户有几个活跃任务」。
type UserTaskCount struct {
	UserID string
	Count  int
}

// QueueOverview 取全局队列概览。
//
// 三条查询顺序执行而不是并发:D1 的 HTTP API 每次调用都有往返,
// 而这是管理员低频操作,并发省下的时间抵不上多写的并发控制。
func (r *Repository) QueueOverview(ctx context.Context, limit int) (QueueOverview, error) {
	if limit <= 0 {
		limit = 10
	}

	rows, err := r.db.FetchAll(ctx,
		"SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")
	if err != nil {
		return QueueOverview{}, fmt.Errorf("统计任务状态失败: %w", err)
	}
	counts := map[string]int{}
	for _, row := range rows {
		counts[str(row["status"])] = int(intOf(row["n"]))
	}

	active, err := r.db.FetchAll(ctx, taskSelect+`
		WHERE status IN (`+activeStatusSQL+`)
		ORDER BY updated_at DESC LIMIT ?`, limit)
	if err != nil {
		return QueueOverview{}, fmt.Errorf("查询活跃任务失败: %w", err)
	}
	activeTasks, err := rowsToTasks(active)
	if err != nil {
		return QueueOverview{}, err
	}

	userRows, err := r.db.FetchAll(ctx, `
		SELECT user_id, COUNT(*) AS n FROM tasks
		WHERE status IN (`+activeStatusSQL+`)
		GROUP BY user_id ORDER BY n DESC LIMIT 5`)
	if err != nil {
		return QueueOverview{}, fmt.Errorf("统计用户活跃分布失败: %w", err)
	}
	userCounts := make([]UserTaskCount, 0, len(userRows))
	for _, row := range userRows {
		userCounts = append(userCounts, UserTaskCount{
			UserID: str(row["user_id"]),
			Count:  int(intOf(row["n"])),
		})
	}

	return QueueOverview{StatusCounts: counts, ActiveTasks: activeTasks, UserCounts: userCounts}, nil
}

// TasksByStatus 是按状态分页的结果。
type TasksByStatus struct {
	Tasks      []Task
	Total      int
	Page       int
	PageSize   int
	TotalPages int
}

// TasksByStatus 按状态分页查任务 —— /task_queue 的状态详情页。
func (r *Repository) TasksByStatus(ctx context.Context, status string, page, pageSize int) (TasksByStatus, error) {
	if pageSize <= 0 {
		pageSize = 8
	}
	if page < 0 {
		page = 0
	}

	rows, err := r.db.FetchAll(ctx, taskSelect+`
		WHERE status = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
		status, pageSize, page*pageSize)
	if err != nil {
		return TasksByStatus{}, fmt.Errorf("查询 %s 状态任务失败: %w", status, err)
	}
	tasks, err := rowsToTasks(rows)
	if err != nil {
		return TasksByStatus{}, err
	}

	countRow, err := r.db.FetchOne(ctx,
		"SELECT COUNT(*) AS n FROM tasks WHERE status = ?", status)
	if err != nil {
		return TasksByStatus{}, fmt.Errorf("统计 %s 状态任务数失败: %w", status, err)
	}
	total := 0
	if countRow != nil {
		total = int(intOf(countRow["n"]))
	}

	totalPages := (total + pageSize - 1) / pageSize
	if totalPages == 0 {
		totalPages = 1
	}
	// 页码越界时收敛到最后一页 —— 回调数据是用户可控的,
	// 直接拿它算 OFFSET 只会得到一个空列表,用户看着像「任务丢了」。
	if page > totalPages-1 {
		page = totalPages - 1
		return r.TasksByStatus(ctx, status, page, pageSize)
	}

	return TasksByStatus{
		Tasks: tasks, Total: total,
		Page: page, PageSize: pageSize, TotalPages: totalPages,
	}, nil
}

// AdminUser 是 /users 列表里的一行。
type AdminUser struct {
	UserID   string
	Role     string
	Drives   int
	Tasks    int
	Active   int
	Complete int
	Failed   int
	// LastSeenAt 是毫秒时间戳,0 表示无记录。
	LastSeenAt int64
}

// AdminUsersSummary 是列表顶部的汇总行。
type AdminUsersSummary struct {
	Total   int
	Active  int
	Admins  int
	Banned  int
	NoDrive int
}

// AdminUsersPage 是一页用户列表。
type AdminUsersPage struct {
	Filter     string
	Users      []AdminUser
	Summary    AdminUsersSummary
	Page       int
	PageSize   int
	TotalPages int
}

// adminFilters 与 JS 侧 ADMIN_USER_FILTERS 一致。
var adminFilters = map[string]bool{
	"all": true, "active": true, "admin": true, "banned": true, "nodrive": true,
}

// NormalizeAdminFilter 归一筛选名 —— 未登记的一律当 all。
func NormalizeAdminFilter(f string) string {
	if adminFilters[f] {
		return f
	}
	return "all"
}

// adminFilterWhere 与 JS 侧 UserRepository._filterWhere 一致。
func adminFilterWhere(filter string) string {
	switch filter {
	case "active":
		return "active_task_count > 0"
	case "admin":
		return "role IN ('owner', 'admin')"
	case "banned":
		return "role = 'banned'"
	case "nodrive":
		return "active_drive_count = 0"
	default:
		return "1 = 1"
	}
}

// adminUserCTE 与 JS 侧 UserRepository._cte 一致。
//
// 用户集合是三处来源的并集(有角色的 / 提过任务的 / 绑了盘的),
// 少一处就会让某类用户在管理员眼里凭空消失 —— 而「谁在用我的机器人」
// 正是这个页面要回答的问题。
const adminUserCTE = `
WITH seed_users AS (
    SELECT user_id FROM user_roles
    UNION
    SELECT user_id FROM tasks
    UNION
    SELECT user_id FROM drives WHERE status = 'active'
    UNION
    SELECT ? AS user_id WHERE ? IS NOT NULL AND ? <> ''
),
task_stats AS (
    SELECT
        user_id,
        COUNT(*) AS task_count,
        SUM(CASE WHEN status IN ('queued','downloading','downloaded','uploading') THEN 1 ELSE 0 END) AS active_task_count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_task_count,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_task_count,
        MAX(COALESCE(updated_at, created_at, 0)) AS last_task_at
    FROM tasks GROUP BY user_id
),
drive_stats AS (
    SELECT user_id, COUNT(*) AS active_drive_count,
           MAX(COALESCE(updated_at, created_at, 0)) AS last_drive_at
    FROM drives WHERE status = 'active' GROUP BY user_id
),
user_rows AS (
    SELECT
        u.user_id,
        CASE WHEN u.user_id = ? THEN 'owner' ELSE COALESCE(r.role, 'user') END AS role,
        COALESCE(ts.task_count, 0) AS task_count,
        COALESCE(ts.active_task_count, 0) AS active_task_count,
        COALESCE(ts.completed_task_count, 0) AS completed_task_count,
        COALESCE(ts.failed_task_count, 0) AS failed_task_count,
        COALESCE(ds.active_drive_count, 0) AS active_drive_count,
        MAX(
            COALESCE(ts.last_task_at, 0),
            COALESCE(ds.last_drive_at, 0),
            COALESCE(r.updated_at, r.created_at, 0)
        ) AS last_seen_at
    FROM seed_users u
    LEFT JOIN user_roles r ON r.user_id = u.user_id
    LEFT JOIN task_stats ts ON ts.user_id = u.user_id
    LEFT JOIN drive_stats ds ON ds.user_id = u.user_id
    WHERE u.user_id IS NOT NULL AND u.user_id <> ''
)`

// cteOwnerArgs 是 CTE 里三个位置参数(owner 出现三次)的绑定。
//
// 抽出来是因为它们必须与 SQL 里的 `?` 一一对应且顺序相同 ——
// 数量对不上时 D1 报的是「参数个数不匹配」,而不是「owner 认错了人」。
func cteOwnerArgs(ownerID string) []interface{} {
	o := interface{}(nil)
	if ownerID != "" {
		o = ownerID
	}
	return []interface{}{o, o, o}
}

// ListUsersForAdmin 取一页用户列表 —— /users 的数据源。
func (r *Repository) ListUsersForAdmin(ctx context.Context, filter string, page, pageSize int, ownerID string) (AdminUsersPage, error) {
	filter = NormalizeAdminFilter(filter)
	if pageSize <= 0 {
		pageSize = 8
	}
	if page < 0 {
		page = 0
	}
	where := adminFilterWhere(filter)

	summaryRow, err := r.db.FetchOne(ctx, adminUserCTE+`
		SELECT
			COUNT(*) AS total,
			COALESCE(SUM(CASE WHEN active_task_count > 0 THEN 1 ELSE 0 END), 0) AS active,
			COALESCE(SUM(CASE WHEN role IN ('owner','admin') THEN 1 ELSE 0 END), 0) AS admins,
			COALESCE(SUM(CASE WHEN role = 'banned' THEN 1 ELSE 0 END), 0) AS banned,
			COALESCE(SUM(CASE WHEN active_drive_count = 0 THEN 1 ELSE 0 END), 0) AS no_drive
		FROM user_rows`, cteOwnerArgs(ownerID)...)
	if err != nil {
		return AdminUsersPage{}, fmt.Errorf("统计用户汇总失败: %w", err)
	}

	countRow, err := r.db.FetchOne(ctx, adminUserCTE+`
		SELECT COUNT(*) AS total FROM user_rows WHERE `+where, cteOwnerArgs(ownerID)...)
	if err != nil {
		return AdminUsersPage{}, fmt.Errorf("统计用户数失败: %w", err)
	}

	total := 0
	if countRow != nil {
		total = int(intOf(countRow["total"]))
	}
	totalPages := (total + pageSize - 1) / pageSize
	if totalPages == 0 {
		totalPages = 1
	}
	if page > totalPages-1 {
		page = totalPages - 1
	}

	rows, err := r.db.FetchAll(ctx, adminUserCTE+`
		SELECT user_id, role, task_count, active_task_count,
		       completed_task_count, failed_task_count, active_drive_count, last_seen_at
		FROM user_rows WHERE `+where+`
		ORDER BY last_seen_at DESC,
			CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'trusted' THEN 2
			          WHEN 'user' THEN 3 WHEN 'banned' THEN 4 ELSE 5 END,
			user_id ASC
		LIMIT ? OFFSET ?`,
		append(cteOwnerArgs(ownerID), pageSize, page*pageSize)...)
	if err != nil {
		return AdminUsersPage{}, fmt.Errorf("查询用户列表失败: %w", err)
	}

	users := make([]AdminUser, 0, len(rows))
	for _, row := range rows {
		users = append(users, AdminUser{
			UserID:     str(row["user_id"]),
			Role:       str(row["role"]),
			Drives:     int(intOf(row["active_drive_count"])),
			Tasks:      int(intOf(row["task_count"])),
			Active:     int(intOf(row["active_task_count"])),
			Complete:   int(intOf(row["completed_task_count"])),
			Failed:     int(intOf(row["failed_task_count"])),
			LastSeenAt: intOf(row["last_seen_at"]),
		})
	}

	out := AdminUsersPage{
		Filter: filter, Users: users,
		Page: page, PageSize: pageSize, TotalPages: totalPages,
	}
	if summaryRow != nil {
		out.Summary = AdminUsersSummary{
			Total:   int(intOf(summaryRow["total"])),
			Active:  int(intOf(summaryRow["active"])),
			Admins:  int(intOf(summaryRow["admins"])),
			Banned:  int(intOf(summaryRow["banned"])),
			NoDrive: int(intOf(summaryRow["no_drive"])),
		}
	}
	return out, nil
}

// SetSetting 写系统设置(开关服务模式用它)。
func (r *Repository) SetSetting(ctx context.Context, key, value string) error {
	now := time.Now().UnixMilli()
	_, err := r.db.Exec(ctx, `
		INSERT INTO settings (key, value, created_at, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, value, now, now)
	if err != nil {
		return fmt.Errorf("写设置 %s 失败: %w", key, err)
	}
	return nil
}

// GetSetting 读系统设置;没有这一项时返回 def。
func (r *Repository) GetSetting(ctx context.Context, key, def string) (string, error) {
	row, err := r.db.FetchOne(ctx, "SELECT value FROM settings WHERE key = ?", key)
	if err != nil {
		return def, fmt.Errorf("读设置 %s 失败: %w", key, err)
	}
	if row == nil {
		return def, nil
	}
	v := strings.TrimSpace(str(row["value"]))
	if v == "" {
		return def, nil
	}
	return v, nil
}

// AccessModeKey 是访问模式的设置键 —— 与 JS 侧 SettingsRepository
// 用的是同一个 key,切换期两边读到的是同一个值。
const AccessModeKey = "setting:access_mode"

// AccessModePublic / AccessModePrivate 是两个合法取值。
const (
	AccessModePublic  = "public"
	AccessModePrivate = "private"
)

// NormalizeAccessMode 把任意输入收敛到两个合法值。
func NormalizeAccessMode(v string) string {
	if v == AccessModePrivate {
		return AccessModePrivate
	}
	return AccessModePublic
}
