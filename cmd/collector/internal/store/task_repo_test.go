package store

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/d1"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// fakeD1 是一个内存版的 D1,按 SQL 前缀返回预置结果。
// 不追求 SQL 引擎 —— 只验证我们发出的 SQL 形状和返回值处理。
type fakeD1 struct {
	mu       sync.Mutex
	requests []capturedReq
	// responder 按顺序返回响应;用尽后返回最后一个。
	responder   func(req capturedReq) string
	rowsWritten int64
}

type capturedReq struct {
	SQL    string        `json:"sql"`
	Params []interface{} `json:"params"`
}

func (f *fakeD1) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req capturedReq
		_ = json.Unmarshal(raw, &req)

		f.mu.Lock()
		f.requests = append(f.requests, req)
		body := f.responder(req)
		f.mu.Unlock()

		w.Write([]byte(body))
	}
}

// strictD1 在 fakeD1 之上【强制执行 D1 的绑定参数上限】。
//
// 为什么必须模拟这条约束:参数上限是「发相册没反应」的直接原因,
// 而不模拟它的假实现会让 CreateBatch 的分片逻辑永远测不出来 ——
// 测试全绿而生产必炸。实测报错原文:
//
//	"too many SQL variables at offset 388: SQLITE_ERROR"
type strictD1 struct {
	*fakeD1
}

func strictNewTestRepo(t *testing.T) (*Repository, *strictD1) {
	t.Helper()
	f := &strictD1{fakeD1: &fakeD1{
		responder: func(capturedReq) string { return oneWritten },
	}}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var req capturedReq
		_ = json.Unmarshal(raw, &req)

		f.mu.Lock()
		f.requests = append(f.requests, req)
		f.mu.Unlock()

		if len(req.Params) > d1MaxParams {
			w.Write([]byte(`{"success":false,"errors":[{"code":7500,` +
				`"message":"too many SQL variables: SQLITE_ERROR"}]}`))
			return
		}
		w.Write([]byte(oneWritten))
	}))
	t.Cleanup(srv.Close)

	db, err := d1.New(d1.Config{
		AccountID: "a", DatabaseID: "d", Token: "t",
		BaseURL: srv.URL, Log: quiet(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return NewTaskRepository(db), f
}

// TestCreateBatchRespectsD1ParamLimit 相册常有 8~10 张图,而 D1 对绑定
// 参数有 100 的硬上限:14 列 × 8 行 = 112,整条语句直接失败。
//
// 这条测试用【模拟了参数上限】的假 D1 —— 之前的 fakeD1 不检查参数数,
// 于是 CreateBatch 的 3 条用例(42 参数)永远绿着,生产却 100% 失败。
func TestCreateBatchRespectsD1ParamLimit(t *testing.T) {
	r, f := strictNewTestRepo(t)

	const n = 10 // 用户发 10 张图的相册
	tasks := make([]Task, n)
	for i := range tasks {
		tasks[i] = Task{ID: fmt.Sprintf("t%d", i), UserID: "u1"}
	}

	if err := r.CreateBatch(context.Background(), tasks); err != nil {
		t.Fatalf("10 条任务建不起来(生产实测 8 条就失败): %v", err)
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) == 0 {
		t.Fatal("一条请求都没发")
	}
	total := 0
	for _, req := range f.requests {
		if len(req.Params) > d1MaxParams {
			t.Errorf("某条语句带了 %d 个参数,超过 D1 上限 %d", len(req.Params), d1MaxParams)
		}
		total += len(req.Params) / taskInsertColumns
	}
	if total != n {
		t.Errorf("共插入 %d 行,期望 %d —— 有任务被静默丢掉", total, n)
	}
}

func (f *fakeD1) last() capturedReq {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) == 0 {
		return capturedReq{}
	}
	return f.requests[len(f.requests)-1]
}

func newTestRepo(t *testing.T, f *fakeD1) *Repository {
	t.Helper()
	srv := httptest.NewServer(f.handler())
	t.Cleanup(srv.Close)

	db, err := d1.New(d1.Config{
		AccountID: "a", DatabaseID: "d", Token: "t",
		BaseURL: srv.URL, Log: quiet(),
	})
	if err != nil {
		t.Fatal(err)
	}
	return NewTaskRepository(db)
}

const oneRow = `{"success":true,"result":[{"success":true,"results":[` +
	`{"id":"t1","user_id":"u1","status":"queued","file_size":0,` +
	`"created_at":100,"updated_at":100,"source_type":"telegram_media"}]}]}`

const noRows = `{"success":true,"result":[{"success":true,"results":[]}]}`

const oneWritten = `{"success":true,"result":[{"success":true,"results":[],` +
	`"meta":{"rows_written":1}}]}`

// TestCreateSendsFullRow 创建必须带上所有 NOT NULL 列。
func TestCreateSendsFullRow(t *testing.T) {
	f := &fakeD1{responder: func(capturedReq) string { return oneWritten }}
	r := newTestRepo(t, f)

	if err := r.Create(context.Background(), Task{ID: "t1", UserID: "u1"}); err != nil {
		t.Fatal(err)
	}

	req := f.last()
	if !strings.Contains(req.SQL, "INSERT INTO tasks") {
		t.Errorf("SQL = %q", req.SQL)
	}
	// id / user_id 是 NOT NULL,必须出现在 params 里
	if len(req.Params) != 15 {
		t.Errorf("参数个数 = %d,期望 15\nSQL: %s", len(req.Params), req.SQL)
	}
	if req.Params[0] != "t1" || req.Params[1] != "u1" {
		t.Errorf("前两个参数 = %v, %v", req.Params[0], req.Params[1])
	}
	// grouped_id 排在 source_msg_id 之后,无组时必须是 NULL
	if req.Params[5] != nil {
		t.Errorf("grouped_id 默认 = %v,期望 nil", req.Params[5])
	}
	// 默认值要和 schema 对齐
	if req.Params[6] != "telegram_media" {
		t.Errorf("source_type 默认值 = %v,期望 telegram_media", req.Params[6])
	}
	if req.Params[10] != string(contract.StatusQueued) {
		t.Errorf("status 默认值 = %v,期望 queued", req.Params[10])
	}
}

// TestTransitionUsesOptimisticLock 这是本文件最重要的一条。
//
// WHERE 必须同时带 id 和 status。少了 status,两个并发请求会把同一个
// 任务推进两次 —— 用户表现为「同一个文件传了两遍」,而且只在高并发下
// 出现,极难复现。
func TestTransitionUsesOptimisticLock(t *testing.T) {
	f := &fakeD1{responder: func(req capturedReq) string {
		if strings.HasPrefix(req.SQL, "SELECT") {
			return oneRow
		}
		return oneWritten
	}}
	r := newTestRepo(t, f)

	if _, err := r.Transition(context.Background(), "t1", contract.EventStartDownload, nil); err != nil {
		t.Fatal(err)
	}

	req := f.last()
	if !strings.Contains(req.SQL, "WHERE id = ? AND status = ?") {
		t.Errorf("乐观锁缺失!\nSQL: %s", req.SQL)
	}
	// 最后一个两个参数必须是 taskId 和原状态
	n := len(req.Params)
	if req.Params[n-2] != "t1" {
		t.Errorf("倒数第二参数 = %v,期望 taskId", req.Params[n-2])
	}
	if req.Params[n-1] != string(contract.StatusQueued) {
		t.Errorf("最后参数 = %v,期望原状态 queued(用于乐观锁比较)", req.Params[n-1])
	}
}

// TestTransitionClearsClaimOnTerminal 终态必须清掉认领信息 ——
// 否则僵尸任务的认领记录会一直被续租。
func TestTransitionClearsClaimOnTerminal(t *testing.T) {
	f := &fakeD1{responder: func(req capturedReq) string {
		if strings.HasPrefix(req.SQL, "SELECT") {
			return oneRow // 状态 queued
		}
		return oneWritten
	}}
	r := newTestRepo(t, f)

	if _, err := r.Transition(context.Background(), "t1", contract.EventComplete, nil); err != nil {
		t.Fatal(err)
	}

	sql := f.last().SQL
	if !strings.Contains(sql, "claimed_by = NULL") || !strings.Contains(sql, "claim_lease_id = NULL") {
		t.Errorf("终态转移未清除认领信息:\n%s", sql)
	}
}

// TestTransitionMissingTaskIsBlocked 任务不存在要明确返回 blocked,不是错误。
func TestTransitionMissingTaskIsBlocked(t *testing.T) {
	f := &fakeD1{responder: func(capturedReq) string { return noRows }}
	r := newTestRepo(t, f)

	res, err := r.Transition(context.Background(), "missing", contract.EventStartDownload, nil)
	if err != nil {
		t.Fatalf("任务不存在不该报 error,得到 %v", err)
	}
	if !res.Blocked {
		t.Errorf("res = %+v,期望 Blocked", res)
	}
	if res.Changed {
		t.Error("不存在的任务不该 Changed")
	}
}

// TestTransitionInvalidIsBlocked 状态机拒绝的转移要 blocked 而不是尝试执行。
func TestTransitionInvalidIsBlocked(t *testing.T) {
	// 任务当前是 cancelled,再 start_download 应被状态机拒绝
	row := `{"success":true,"result":[{"success":true,"results":[` +
		`{"id":"t1","user_id":"u1","status":"cancelled","created_at":1,"updated_at":1}]}]}`
	f := &fakeD1{responder: func(req capturedReq) string {
		if strings.HasPrefix(req.SQL, "SELECT") {
			return row
		}
		t.Error("被状态机拒绝后不应发出 UPDATE")
		return oneWritten
	}}
	r := newTestRepo(t, f)

	res, err := r.Transition(context.Background(), "t1", contract.EventStartDownload, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Blocked {
		t.Errorf("res = %+v,期望 Blocked", res)
	}
}

// TestTransitionRaceDetection 没命中乐观锁时要重新确认状态。
func TestTransitionRaceDetection(t *testing.T) {
	var calls int
	f := &fakeD1{responder: func(req capturedReq) string {
		if strings.HasPrefix(req.SQL, "SELECT") {
			calls++
			if calls == 1 {
				return oneRow // queued
			}
			// 并发把状态推到了目标态
			return `{"success":true,"result":[{"success":true,"results":[` +
				`{"id":"t1","user_id":"u1","status":"downloading","created_at":1,"updated_at":2}]}]}`
		}
		// UPDATE 命中 0 行 —— 被别人抢先了
		return `{"success":true,"result":[{"success":true,"results":[],` +
			`"meta":{"rows_written":0}}]}`
	}}
	r := newTestRepo(t, f)

	res, err := r.Transition(context.Background(), "t1", contract.EventStartDownload, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Changed {
		t.Error("0 行更新不该报 Changed")
	}
	if !res.Idempotent {
		t.Error("并发已推到目标态时应报 Idempotent")
	}
}

// TestCreateBatchUsesMultiValueInsert 媒体组一次十几条,逐条往返太慢。
func TestCreateBatchUsesMultiValueInsert(t *testing.T) {
	f := &fakeD1{responder: func(capturedReq) string { return oneWritten }}
	r := newTestRepo(t, f)

	tasks := make([]Task, 3)
	for i := range tasks {
		tasks[i] = Task{ID: string(rune('a' + i)), UserID: "u1"}
	}
	if err := r.CreateBatch(context.Background(), tasks); err != nil {
		t.Fatal(err)
	}

	req := f.last()
	if got := strings.Count(req.SQL, "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"); got != 3 {
		t.Errorf("多值组数 = %d,期望 3\nSQL: %s", got, req.SQL)
	}
	if len(req.Params) != 45 {
		t.Errorf("参数个数 = %d,期望 45", len(req.Params))
	}
}

// TestCreateBatchEmptyIsNoop 空批次不该发请求。
func TestCreateBatchEmptyIsNoop(t *testing.T) {
	f := &fakeD1{responder: func(capturedReq) string { return oneWritten }}
	r := newTestRepo(t, f)

	if err := r.CreateBatch(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.requests) != 0 {
		t.Errorf("空批次发出了 %d 个请求", len(f.requests))
	}
}

// TestFindStalledExcludesTerminal 僵尸任务查询必须排除终态 ——
// 已完成的任务不该被反复「捞回」。
func TestFindStalledExcludesTerminal(t *testing.T) {
	f := &fakeD1{responder: func(capturedReq) string { return noRows }}
	r := newTestRepo(t, f)

	if _, err := r.FindStalledTasks(context.Background(), 5*time.Minute); err != nil {
		t.Fatal(err)
	}
	sql := f.last().SQL
	for _, term := range []string{"completed", "failed", "cancelled"} {
		if !strings.Contains(sql, term) {
			t.Errorf("僵尸查询未排除终态 %s:\n%s", term, sql)
		}
	}
}

// TestFindByMsgIdDedupes 媒体组去重要按 msg_id 查。
func TestFindByMsgIdDedupes(t *testing.T) {
	f := &fakeD1{responder: func(capturedReq) string { return oneRow }}
	r := newTestRepo(t, f)

	task, err := r.FindByMsgId(context.Background(), 555)
	if err != nil {
		t.Fatal(err)
	}
	if task == nil || task.ID != "t1" {
		t.Errorf("task = %+v", task)
	}
	if !strings.Contains(f.last().SQL, "WHERE msg_id = ?") {
		t.Errorf("SQL = %s", f.last().SQL)
	}
}

// TestNullFieldsRoundTrip null 和空串必须区分 ——
// msg_id 为 0 和 msg_id 未知不是一回事。
func TestNullFieldsRoundTrip(t *testing.T) {
	row := `{"success":true,"result":[{"success":true,"results":[` +
		`{"id":"t1","user_id":"u1","status":"queued",` +
		`"msg_id":null,"file_name":"","created_at":1,"updated_at":1}]}]}`
	f := &fakeD1{responder: func(capturedReq) string { return row }}
	r := newTestRepo(t, f)

	task, err := r.FindById(context.Background(), "t1")
	if err != nil {
		t.Fatal(err)
	}
	if task.MsgID.Valid {
		t.Errorf("msg_id=null 应解析为无效,得到 %+v", task.MsgID)
	}
	if task.FileName.Valid {
		t.Errorf("file_name=\"\" 应解析为无效(空串当无值),得到 %+v", task.FileName)
	}
}

// TestFindByGroupIDQueriesByGid 「取消整组」靠它反查任务 —— 查询必须
// 走 grouped_id(而不是 source_msg_id:那是「具体哪条消息」,一个相册
// 10 条各不相同),参数是 int64 的 gid 而不是字符串。
func TestFindByGroupIDQueriesByGid(t *testing.T) {
	var got capturedReq
	f := &fakeD1{responder: func(req capturedReq) string {
		got = req
		return oneRow
	}}
	r := newTestRepo(t, f)

	tasks, err := r.FindByGroupID(context.Background(), 999888)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got.SQL, "WHERE grouped_id = ?") {
		t.Errorf("SQL 缺 grouped_id 条件: %s", got.SQL)
	}
	// fakeD1 从 JSON 反序列化参数,数字一律是 float64 —— 这里只断言值,
	// 真实的类型由 d1 客户端发给生产 API。
	if got.Params[0] != float64(999888) {
		t.Errorf("参数 = %v,期望 999888", got.Params[0])
	}
	if len(tasks) != 1 || tasks[0].ID != "t1" {
		t.Errorf("返回任务 = %+v", tasks)
	}
}
