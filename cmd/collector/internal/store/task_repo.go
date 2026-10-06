// Package store 是 D1 上的任务仓储。
//
// 与 JS 侧 src/repositories/TaskRepository.js 的差异:只保留单实例
// 场景下真正会被调用的方法。多实例相关的 claim 租约心跳、
// 批量缓冲写入等历史包袱不在这里复刻 —— 但**乐观锁必须保留**:
//
//	UPDATE tasks SET status=? WHERE id=? AND status=?
//
// 这一条 WHERE 是防重复消费的唯一保障。去掉它,两个并发请求会把
// 同一个任务推进两次,用户表现为「同一个文件传了两遍」。
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/d1"
)

// Task 是 tasks 表的一行。
type Task struct {
	ID          string
	UserID      string
	ChatID      sql.NullString
	MsgID       sql.NullInt64
	SourceMsgID sql.NullInt64
	// GroupedID 标识这批任务来自同一个媒体组,批量取消按它归组。
	// 与 SourceMsgID 严格区分:后者是「具体哪条消息」。
	GroupedID  sql.NullInt64
	SourceType string
	SourceRef  sql.NullString
	FileName   sql.NullString
	FileSize   int64
	Status     contract.TaskStatus
	ErrorMsg   sql.NullString
	ClaimedBy  sql.NullString
	CreatedAt  int64
	UpdatedAt  int64
}

// Repository 是任务仓储。
type Repository struct {
	db *d1.Client
}

func NewTaskRepository(db *d1.Client) *Repository { return &Repository{db: db} }

// Create 插入一个任务。
func (r *Repository) Create(ctx context.Context, t Task) error {
	now := time.Now().UnixMilli()
	if t.CreatedAt == 0 {
		t.CreatedAt = now
	}
	if t.UpdatedAt == 0 {
		t.UpdatedAt = now
	}
	if t.SourceType == "" {
		t.SourceType = "telegram_media"
	}
	if t.Status == "" {
		t.Status = contract.StatusQueued
	}

	_, err := r.db.Exec(ctx, `
		INSERT INTO tasks (
			id, user_id, chat_id, msg_id, source_msg_id, source_type,
			source_ref, file_name, file_size, status, error_msg,
			claimed_by, created_at, updated_at
		) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		t.ID, t.UserID, nullString(t.ChatID), nullInt(t.MsgID), nullInt(t.SourceMsgID),
		t.SourceType, nullString(t.SourceRef), nullString(t.FileName), t.FileSize,
		string(t.Status), nullString(t.ErrorMsg), nullString(t.ClaimedBy),
		t.CreatedAt, t.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("创建任务 %s 失败: %w", t.ID, err)
	}
	return nil
}

// taskInsertColumns 是 tasks 表的插入列清单,14 列。
const taskInsertColumns = 14

// d1MaxParams 是 D1 单条语句的绑定参数上限。
//
// 实测(生产 D1):超过就整条语句失败,报
// "too many SQL variables"。于是 8 条任务(14×8=112)必炸 ——
// 而相册本来就常常有 8~10 张图。这不是理论风险,是「发相册没反应」
// 的直接原因之一。
const d1MaxParams = 100

// batchChunkSize 是每个 INSERT 携带多少行:100/14 = 7。
const batchChunkSize = d1MaxParams / taskInsertColumns

// CreateBatch 批量插入 —— 媒体组一次最多十几条,逐条 INSERT 往返太多。
//
// 用多值 INSERT 而不是逐条调用:D1 的 REST 端点没有事务语义,
// 逐条调用反而更慢。
//
// 【必须按 d1MaxParams 切片】D1 对绑定参数数量有硬上限(见常量),
// 一条 8 行的多值 INSERT 就超了。切片是唯一的解法 —— 分成几条
// 语句比退回逐条插入便宜得多,而 D1 的 batch 本来就是逐条独立生效的,
// 不存在「整批原子」这回事,所以切片不改变语义。
func (r *Repository) CreateBatch(ctx context.Context, tasks []Task) error {
	if len(tasks) == 0 {
		return nil
	}
	now := time.Now().UnixMilli()
	for i := range tasks {
		if tasks[i].CreatedAt == 0 {
			tasks[i].CreatedAt = now
		}
		if tasks[i].UpdatedAt == 0 {
			tasks[i].UpdatedAt = now
		}
		if tasks[i].SourceType == "" {
			tasks[i].SourceType = "telegram_media"
		}
		if tasks[i].Status == "" {
			tasks[i].Status = contract.StatusQueued
		}
	}

	for start := 0; start < len(tasks); start += batchChunkSize {
		end := start + batchChunkSize
		if end > len(tasks) {
			end = len(tasks)
		}
		if err := r.insertChunk(ctx, tasks[start:end]); err != nil {
			return fmt.Errorf("批量创建任务失败(第 %d~%d 条,共 %d 条): %w",
				start+1, end, len(tasks), err)
		}
	}
	return nil
}

// insertChunk 发一条多值 INSERT。
func (r *Repository) insertChunk(ctx context.Context, tasks []Task) error {
	var b strings.Builder
	b.WriteString(`INSERT INTO tasks (
		id, user_id, chat_id, msg_id, source_msg_id, source_type,
		source_ref, file_name, file_size, status, error_msg,
		claimed_by, created_at, updated_at) VALUES `)
	args := make([]interface{}, 0, len(tasks)*taskInsertColumns)

	for i, t := range tasks {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString("(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
		args = append(args, t.ID, t.UserID, nullString(t.ChatID), nullInt(t.MsgID),
			nullInt(t.SourceMsgID), t.SourceType, nullString(t.SourceRef),
			nullString(t.FileName), t.FileSize, string(t.Status),
			nullString(t.ErrorMsg), nullString(t.ClaimedBy), t.CreatedAt, t.UpdatedAt)
	}

	_, err := r.db.Exec(ctx, b.String(), args...)
	return err
}

// FindById 按主键查一个任务。
func (r *Repository) FindById(ctx context.Context, taskID string) (*Task, error) {
	row, err := r.db.FetchOne(ctx, taskSelect+` WHERE id = ?`, taskID)
	if err != nil {
		return nil, fmt.Errorf("查询任务 %s 失败: %w", taskID, err)
	}
	if row == nil {
		return nil, nil
	}
	return rowToTask(row)
}

// FindByUserId 查用户的最近任务。
func (r *Repository) FindByUserId(ctx context.Context, userID string, limit int) ([]Task, error) {
	if limit <= 0 {
		limit = 10
	}
	rows, err := r.db.FetchAll(ctx,
		taskSelect+` WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("查询用户 %s 的任务失败: %w", userID, err)
	}
	return rowsToTasks(rows)
}

// FindByMsgId 按 Telegram 消息 ID 查 —— 用于消息组聚合时去重。
func (r *Repository) FindByMsgId(ctx context.Context, msgID int64) (*Task, error) {
	row, err := r.db.FetchOne(ctx, taskSelect+` WHERE msg_id = ? ORDER BY created_at DESC LIMIT 1`, msgID)
	if err != nil {
		return nil, fmt.Errorf("按 msg_id %d 查询失败: %w", msgID, err)
	}
	if row == nil {
		return nil, nil
	}
	return rowToTask(row)
}

// FindStalledTasks 找长时间没更新的非终态任务。
//
// 单实例下这仍然必要:进程崩溃/被杀会留下 downloading/uploading 的
// 僵尸任务,不捞回来用户就永远等不到结果。
func (r *Repository) FindStalledTasks(ctx context.Context, timeout time.Duration) ([]Task, error) {
	cutoff := time.Now().Add(-timeout).UnixMilli()
	rows, err := r.db.FetchAll(ctx, taskSelect+`
		WHERE status NOT IN ('completed','failed','cancelled')
		  AND updated_at < ?
		ORDER BY created_at ASC`, cutoff)
	if err != nil {
		return nil, fmt.Errorf("查询僵尸任务失败: %w", err)
	}
	return rowsToTasks(rows)
}

// TransitionResult 是一次状态转移的结果。
type TransitionResult struct {
	Changed    bool
	Blocked    bool
	Idempotent bool
	Reason     string
	Event      contract.TaskEvent
	FromStatus contract.TaskStatus
	ToStatus   contract.TaskStatus
}

// Transition 把任务推进到目标状态。
//
// 乐观锁在这里:`WHERE id = ? AND status = ?`。
// 两个并发请求同时推进同一任务时,只有一个能命中,另一个拿到
// changed=false —— 这就是防重复消费的全部机制。
func (r *Repository) Transition(
	ctx context.Context,
	taskID string,
	eventOrStatus contract.TaskEvent,
	errorMsg *string,
) (TransitionResult, error) {
	current, err := r.FindById(ctx, taskID)
	if err != nil {
		return TransitionResult{}, err
	}
	if current == nil {
		return TransitionResult{Blocked: true, Reason: "Task not found"}, nil
	}

	resolution, err := contract.ResolveTransition(current.Status, eventOrStatus)
	if err != nil {
		return TransitionResult{}, err
	}
	if !resolution.Allowed {
		return TransitionResult{
			Blocked:    true,
			Reason:     resolution.Reason,
			Event:      resolution.Event,
			FromStatus: current.Status,
			ToStatus:   resolution.ToStatus,
		}, nil
	}

	now := time.Now().UnixMilli()
	assignments, params := buildTransitionSQL(resolution.ToStatus, errorMsg, now)

	// 终态和回到 queued 时清掉认领信息,与 JS 侧 _buildTransitionSQL 一致。
	if resolution.ToStatus == contract.StatusQueued ||
		contract.IsTerminalStatus(resolution.ToStatus) {
		assignments = append(assignments, "claimed_by = NULL", "claim_lease_id = NULL")
	}

	args := append(append([]interface{}{}, params...), taskID, string(current.Status))
	changed, err := r.db.Exec(ctx,
		"UPDATE tasks SET "+strings.Join(assignments, ", ")+" WHERE id = ? AND status = ?", args...)
	if err != nil {
		return TransitionResult{}, fmt.Errorf("转移任务 %s 失败: %w", taskID, err)
	}

	out := TransitionResult{
		Changed:    changed > 0,
		Event:      resolution.Event,
		FromStatus: current.Status,
		ToStatus:   resolution.ToStatus,
		Idempotent: resolution.Idempotent,
	}
	if changed == 0 {
		// 没命中乐观锁 —— 可能并发已经推进过了。重新读一次确认终态。
		latest, err := r.FindById(ctx, taskID)
		if err != nil {
			return out, err
		}
		if latest != nil && latest.Status == resolution.ToStatus {
			out.Idempotent = true
		} else {
			out.Reason = "concurrent transition detected"
		}
	}
	return out, nil
}

// MarkCancelled 取消任务。
func (r *Repository) MarkCancelled(ctx context.Context, taskID string) (TransitionResult, error) {
	return r.Transition(ctx, taskID, contract.EventCancel, nil)
}

// UpdateFileMetadata 补文件元信息 —— Telegram 下载完才知道真实大小。
func (r *Repository) UpdateFileMetadata(ctx context.Context, taskID, fileName string, fileSize int64) error {
	_, err := r.db.Exec(ctx,
		"UPDATE tasks SET file_name = ?, file_size = ?, updated_at = ? WHERE id = ?",
		fileName, fileSize, time.Now().UnixMilli(), taskID)
	if err != nil {
		return fmt.Errorf("更新任务 %s 文件元信息失败: %w", taskID, err)
	}
	return nil
}

// UpdateSourceRef 记录网盘上的目标路径 —— 出错时要能告诉用户文件原本该去哪。
func (r *Repository) UpdateSourceRef(ctx context.Context, taskID, sourceRef string) error {
	_, err := r.db.Exec(ctx,
		"UPDATE tasks SET source_ref = ?, updated_at = ? WHERE id = ?",
		sourceRef, time.Now().UnixMilli(), taskID)
	if err != nil {
		return fmt.Errorf("更新任务 %s source_ref 失败: %w", taskID, err)
	}
	return nil
}

// UpdateMsgID 回填状态消息的 id。
//
// 媒体组路径需要它:那批任务是【先落库、再发状态消息】——顺序反了的话,
// 建任务失败时用户已经收到 N 条「已捕获」,而每条的取消按钮都指向一个
// 不存在的任务。所以 msg_id 只能在消息发出后才知道,只能回填。
func (r *Repository) UpdateMsgID(ctx context.Context, taskID string, msgID int) error {
	if msgID == 0 {
		return nil // 发不出去时保持 NULL,后续阶段会退回发新消息
	}
	_, err := r.db.Exec(ctx,
		"UPDATE tasks SET msg_id = ? WHERE id = ?", msgID, taskID)
	if err != nil {
		return fmt.Errorf("回填任务 %s 的 msg_id 失败: %w", taskID, err)
	}
	return nil
}

// CountByStatus 统计各状态任务数 —— 队列概览用。
func (r *Repository) CountByStatus(ctx context.Context) (map[string]int, error) {
	rows, err := r.db.FetchAll(ctx, "SELECT status, COUNT(*) AS n FROM tasks GROUP BY status")
	if err != nil {
		return nil, fmt.Errorf("统计任务状态失败: %w", err)
	}
	out := map[string]int{}
	for _, row := range rows {
		s, _ := row["status"].(string)
		n, _ := row["n"].(float64)
		out[s] = int(n)
	}
	return out, nil
}

// FindActiveByUserId 查用户当前活跃(未终结)的任务 —— /status 的「活跃任务」区。
func (r *Repository) FindActiveByUserId(ctx context.Context, userID string, limit int) ([]Task, error) {
	if limit <= 0 {
		limit = 10
	}
	rows, err := r.db.FetchAll(ctx, taskSelect+`
		WHERE user_id = ? AND status IN ('queued','downloading','downloaded','uploading')
		ORDER BY updated_at DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, fmt.Errorf("查询用户 %s 的活跃任务失败: %w", userID, err)
	}
	return rowsToTasks(rows)
}

// CountByUserStatus 统计某个用户各状态的任务数 —— /status 的队列概览用。
func (r *Repository) CountByUserStatus(ctx context.Context, userID string) (map[string]int, error) {
	rows, err := r.db.FetchAll(ctx,
		"SELECT status, COUNT(*) AS n FROM tasks WHERE user_id = ? GROUP BY status", userID)
	if err != nil {
		return nil, fmt.Errorf("统计用户 %s 的任务状态失败: %w", userID, err)
	}
	out := map[string]int{}
	for _, row := range rows {
		s, _ := row["status"].(string)
		n, _ := row["n"].(float64)
		out[s] = int(n)
	}
	return out, nil
}

const taskSelect = `SELECT id, user_id, chat_id, msg_id, source_msg_id, source_type,
	source_ref, file_name, file_size, status, error_msg, claimed_by,
	created_at, updated_at FROM tasks`

// buildTransitionSQL 与 JS 侧 _buildTransitionSQL 对齐。
func buildTransitionSQL(target contract.TaskStatus, errorMsg *string, now int64) ([]string, []interface{}) {
	var errVal interface{}
	if errorMsg != nil {
		errVal = *errorMsg
	}
	return []string{"status = ?", "error_msg = ?", "updated_at = ?"},
		[]interface{}{string(target), errVal, now}
}

func rowToTask(row map[string]interface{}) (*Task, error) {
	t := &Task{}
	t.ID = str(row["id"])
	t.UserID = str(row["user_id"])
	t.ChatID = nullOf(str(row["chat_id"]))
	t.MsgID = nullIntOf(row["msg_id"])
	t.SourceMsgID = nullIntOf(row["source_msg_id"])
	t.SourceType = str(row["source_type"])
	t.SourceRef = nullOf(str(row["source_ref"]))
	t.FileName = nullOf(str(row["file_name"]))
	t.FileSize = intOf(row["file_size"])
	t.Status = contract.TaskStatus(str(row["status"]))
	t.ErrorMsg = nullOf(str(row["error_msg"]))
	t.ClaimedBy = nullOf(str(row["claimed_by"]))
	t.CreatedAt = intOf(row["created_at"])
	t.UpdatedAt = intOf(row["updated_at"])
	return t, nil
}

func rowsToTasks(rows []map[string]interface{}) ([]Task, error) {
	out := make([]Task, 0, len(rows))
	for _, row := range rows {
		t, err := rowToTask(row)
		if err != nil {
			return nil, err
		}
		out = append(out, *t)
	}
	return out, nil
}

func str(v interface{}) string {
	s, _ := v.(string)
	return s
}

func intOf(v interface{}) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case json.Number:
		i, _ := n.Int64()
		return i
	default:
		return 0
	}
}

func nullOf(s string) sql.NullString { return sql.NullString{String: s, Valid: s != ""} }

func nullInt(n sql.NullInt64) interface{} {
	if !n.Valid {
		return nil
	}
	return n.Int64
}

// nullIntOf 把 D1 返回的值转成 sql.NullInt64。
// D1 的 JSON 里数字是 float64,而「没有值」是 null 或缺失 ——
// 两者必须区分:msg_id 为 0 和 msg_id 未知不是一回事。
func nullIntOf(v interface{}) sql.NullInt64 {
	switch n := v.(type) {
	case float64:
		return sql.NullInt64{Int64: int64(n), Valid: true}
	case int64:
		return sql.NullInt64{Int64: n, Valid: true}
	case json.Number:
		i, err := n.Int64()
		return sql.NullInt64{Int64: i, Valid: err == nil}
	default:
		return sql.NullInt64{}
	}
}

func nullString(s sql.NullString) interface{} {
	if !s.Valid {
		return nil
	}
	return s.String
}
