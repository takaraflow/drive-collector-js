package contract

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// vector 由 JS 侧 TaskStateMachine 机器导出(见 package.json 的
// `test:vectors` 脚本)。Go 侧逐条比对 —— 任何一侧语义漂移都会红。
type vector struct {
	From       string `json:"from"`
	Input      string `json:"input"`
	Error      string `json:"error"`
	Allowed    bool   `json:"allowed"`
	Event      string `json:"event"`
	ToStatus   string `json:"toStatus"`
	Idempotent bool   `json:"idempotent"`
	Reason     string `json:"reason"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	path := filepath.Join("..", "..", "testdata", "task_state_vectors.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取向量失败: %v", err)
	}
	var vs []vector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatalf("解析向量失败: %v", err)
	}
	return vs
}

// TestStateMachineMatchesJS 是迁移的核心护栏:Go 与 JS 对同一组
// (from, event) 必须给出完全相同的结论。
func TestStateMachineMatchesJS(t *testing.T) {
	for _, v := range loadVectors(t) {
		res, err := ResolveTransition(TaskStatus(v.From), TaskEvent(v.Input))

		if v.Error != "" {
			if err == nil {
				t.Errorf("%s + %s: JS 期望错误 %q,Go 返回成功", v.From, v.Input, v.Error)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s + %s: Go 返回错误 %v,JS 期望成功", v.From, v.Input, err)
			continue
		}

		if res.Allowed != v.Allowed {
			t.Errorf("%s + %s: allowed = %v,JS = %v", v.From, v.Input, res.Allowed, v.Allowed)
		}
		if string(res.Event) != v.Event {
			t.Errorf("%s + %s: event = %q,JS = %q", v.From, v.Input, res.Event, v.Event)
		}
		if string(res.ToStatus) != v.ToStatus {
			t.Errorf("%s + %s: toStatus = %q,JS = %q", v.From, v.Input, res.ToStatus, v.ToStatus)
		}
		if res.Idempotent != v.Idempotent {
			t.Errorf("%s + %s: idempotent = %v,JS = %v", v.From, v.Input, res.Idempotent, v.Idempotent)
		}
		if res.Reason != v.Reason {
			t.Errorf("%s + %s: reason = %q,JS = %q", v.From, v.Input, res.Reason, v.Reason)
		}
	}
}

// TestStateMachineEdgeCases 覆盖向量之外但迁移中会真实用到的路径。
func TestStateMachineEdgeCases(t *testing.T) {
	t.Run("终态集合", func(t *testing.T) {
		for _, s := range []TaskStatus{StatusCompleted, StatusFailed, StatusCancelled} {
			if !IsTerminalStatus(s) {
				t.Errorf("%s 应为终态", s)
			}
			if IsActiveStatus(s) {
				t.Errorf("%s 不应是活跃态", s)
			}
		}
		for _, s := range []TaskStatus{StatusQueued, StatusDownloading, StatusDownloaded, StatusUploading} {
			if !IsActiveStatus(s) {
				t.Errorf("%s 应为活跃态", s)
			}
			if IsTerminalStatus(s) {
				t.Errorf("%s 不应是终态", s)
			}
		}
	})

	t.Run("传目标状态等价于传事件", func(t *testing.T) {
		// JS 侧 resolveTransition 同时接受事件名和目标状态名。
		byEvent, err := ResolveTransition(StatusQueued, EventStartDownload)
		if err != nil {
			t.Fatal(err)
		}
		byStatus, err := ResolveTransition(StatusQueued, TaskEvent(StatusDownloading))
		if err != nil {
			t.Fatal(err)
		}
		if byEvent.ToStatus != byStatus.ToStatus || byEvent.Event != byStatus.Event {
			t.Errorf("传事件和传目标状态结果不一致: %+v vs %+v", byEvent, byStatus)
		}
	})

	t.Run("拒绝转移会报错且带 JS 同样的 code", func(t *testing.T) {
		_, err := AssertTransition(StatusCancelled, EventStartDownload)
		if err == nil {
			t.Fatal("终态不应允许 start_download")
		}
		te, ok := err.(*TransitionError)
		if !ok {
			t.Fatalf("错误类型 = %T,期望 *TransitionError", err)
		}
		if te.Code != errCodeInvalidTransition {
			t.Errorf("code = %q,期望 %q", te.Code, errCodeInvalidTransition)
		}
	})

	t.Run("幂等转移 allowed 且 idempotent", func(t *testing.T) {
		// 这些是 JS 侧 from 集合里真的包含自身的事件 —— 重复投递时
		// 不会因为「已完成」而报错(媒体组重试会走到这里)。
		for _, tc := range []struct {
			from TaskStatus
			ev   TaskEvent
		}{
			{StatusDownloading, EventStartDownload},
			{StatusDownloaded, EventFinishDownload},
			{StatusUploading, EventStartUpload},
			{StatusCompleted, EventComplete},
			{StatusFailed, EventFail},
			{StatusCancelled, EventCancel},
			{StatusQueued, EventRetry},
		} {
			res, err := ResolveTransition(tc.from, tc.ev)
			if err != nil {
				t.Fatalf("%s + %s: %v", tc.from, tc.ev, err)
			}
			if !res.Allowed || !res.Idempotent {
				t.Errorf("%s + %s 应为 allowed+idempotent,实际 %+v", tc.from, tc.ev, res)
			}
		}
	})

	t.Run("非幂等转移标记正确", func(t *testing.T) {
		// uploading + complete 是真转移(→ completed),不是幂等。
		res, err := ResolveTransition(StatusUploading, EventComplete)
		if err != nil {
			t.Fatal(err)
		}
		if !res.Allowed {
			t.Error("uploading + complete 应被允许")
		}
		if res.Idempotent {
			t.Error("uploading + complete 不应标记为幂等")
		}
	})

	t.Run("未知状态被拒", func(t *testing.T) {
		if _, err := ResolveTransition("bogus", EventComplete); err == nil {
			t.Error("未知 current status 应报错")
		}
		if _, err := EventForTargetStatus("bogus"); err == nil {
			t.Error("未知 target status 应报错")
		}
	})

	t.Run("allowedFrom 与 to 不自相矛盾", func(t *testing.T) {
		for ev, tr := range Transitions {
			from, err := AllowedFromForEvent(ev)
			if err != nil {
				t.Fatalf("%s: %v", ev, err)
			}
			if len(from) != len(tr.From) {
				t.Errorf("%s: allowedFrom 长度 %d != from 长度 %d", ev, len(from), len(tr.From))
			}
			target, err := TargetStatusForEvent(ev)
			if err != nil {
				t.Fatalf("%s: %v", ev, err)
			}
			if target != tr.To {
				t.Errorf("%s: targetStatusForEvent = %q,表里是 %q", ev, target, tr.To)
			}
		}
	})
}
