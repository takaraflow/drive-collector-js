// Package contract 是 JS 与 Go 之间唯一的共享契约源。
//
// 每个契约都由同一份 JSON 测试向量同时驱动两侧,任何一侧语义漂移都会
// 让对端测试变红。迁移期间 JS 侧是权威实现,Go 侧是等价移植。
package contract

// TaskStatus 是任务的生命周期状态。
type TaskStatus string

const (
	StatusQueued     TaskStatus = "queued"
	StatusDownloading TaskStatus = "downloading"
	StatusDownloaded TaskStatus = "downloaded"
	StatusUploading  TaskStatus = "uploading"
	StatusCompleted  TaskStatus = "completed"
	StatusFailed     TaskStatus = "failed"
	StatusCancelled  TaskStatus = "cancelled"
)

// AllStatuses 的顺序与 JS 侧 Object.values(TASK_STATUSES) 一致。
var AllStatuses = []TaskStatus{
	StatusQueued, StatusDownloading, StatusDownloaded,
	StatusUploading, StatusCompleted, StatusFailed, StatusCancelled,
}

// TaskEvent 是驱动状态转移的事件。
type TaskEvent string

const (
	EventStartDownload       TaskEvent = "start_download"
	EventFinishDownload      TaskEvent = "finish_download"
	EventStartUpload         TaskEvent = "start_upload"
	EventStartStreamUpload   TaskEvent = "start_stream_upload"
	EventComplete            TaskEvent = "complete"
	EventFail                TaskEvent = "fail"
	EventCancel              TaskEvent = "cancel"
	EventRetry               TaskEvent = "retry"
	EventResetUpload         TaskEvent = "reset_upload"
	EventResetStreamDownload TaskEvent = "reset_stream_download"
	EventResetStalled        TaskEvent = "reset_stalled"
)

var (
	terminalStatuses = map[TaskStatus]bool{
		StatusCompleted: true, StatusFailed: true, StatusCancelled: true,
	}
	activeStatuses = map[TaskStatus]bool{
		StatusQueued: true, StatusDownloading: true,
		StatusDownloaded: true, StatusUploading: true,
	}
	knownStatuses = func() map[TaskStatus]bool {
		m := make(map[TaskStatus]bool, len(AllStatuses))
		for _, s := range AllStatuses {
			m[s] = true
		}
		return m
	}()
)

// Transition 描述一个事件允许的起点与终点。
type Transition struct {
	To   TaskStatus
	From []TaskStatus
}

// Transitions 与 JS 侧 TASK_TRANSITIONS 逐字对应。
var Transitions = map[TaskEvent]Transition{
	EventStartDownload:  {StatusDownloading, []TaskStatus{StatusQueued, StatusDownloading}},
	EventFinishDownload: {StatusDownloaded, []TaskStatus{StatusDownloading, StatusDownloaded}},
	EventStartUpload:    {StatusUploading, []TaskStatus{StatusDownloaded, StatusUploading}},
	EventStartStreamUpload: {StatusUploading, []TaskStatus{StatusDownloading, StatusUploading}},
	EventComplete: {StatusCompleted, []TaskStatus{
		StatusQueued, StatusDownloading, StatusDownloaded,
		StatusUploading, StatusCompleted,
	}},
	EventFail: {StatusFailed, []TaskStatus{
		StatusQueued, StatusDownloading, StatusDownloaded,
		StatusUploading, StatusFailed,
	}},
	EventCancel: {StatusCancelled, []TaskStatus{
		StatusQueued, StatusDownloading, StatusDownloaded,
		StatusUploading, StatusCancelled,
	}},
	EventRetry: {StatusQueued, []TaskStatus{
		StatusQueued, StatusDownloading, StatusDownloaded,
		StatusUploading, StatusFailed,
	}},
	EventResetUpload: {StatusDownloaded, []TaskStatus{StatusDownloaded, StatusUploading}},
	EventResetStreamDownload: {StatusDownloading, []TaskStatus{
		StatusDownloading, StatusUploading, StatusFailed,
	}},
	EventResetStalled: {StatusQueued, []TaskStatus{
		StatusDownloading, StatusDownloaded, StatusUploading,
	}},
}

// eventByTargetStatus 与 JS 侧 EVENT_BY_TARGET_STATUS 对应。
var eventByTargetStatus = map[TaskStatus]TaskEvent{
	StatusQueued:     EventRetry,
	StatusDownloading: EventStartDownload,
	StatusDownloaded: EventFinishDownload,
	StatusUploading:  EventStartUpload,
	StatusCompleted:  EventComplete,
	StatusFailed:     EventFail,
	StatusCancelled:  EventCancel,
}

// TransitionError 对应 JS 侧 TaskStateTransitionError,Code 与其一致。
type TransitionError struct {
	Code    string
	Message string
	// CurrentStatus / Event 仅在对应错误场景下有值
	CurrentStatus TaskStatus
	Event         TaskEvent
}

func (e *TransitionError) Error() string { return e.Message }

const errCodeInvalidTransition = "TASK_STATE_INVALID_TRANSITION"

func invalidTransition(msg string) *TransitionError {
	return &TransitionError{Code: errCodeInvalidTransition, Message: msg}
}

// Resolution 对应 JS 侧 resolveTransition 的返回值。
type Resolution struct {
	Allowed     bool
	Event       TaskEvent
	FromStatus  TaskStatus
	ToStatus    TaskStatus
	Idempotent  bool
	Reason      string
}

func IsKnownStatus(s TaskStatus) bool { return knownStatuses[s] }

func IsTerminalStatus(s TaskStatus) bool { return terminalStatuses[s] }

// IsActiveStatus 对应 JS 侧 TASK_ACTIVE_STATUSES 的成员判断。
func IsActiveStatus(s TaskStatus) bool { return activeStatuses[s] }

func getTransition(e TaskEvent) (Transition, bool) {
	t, ok := Transitions[e]
	return t, ok
}

// EventForTargetStatus 对应 getEventForTargetStatus。
func EventForTargetStatus(s TaskStatus) (TaskEvent, error) {
	if !IsKnownStatus(s) {
		return "", invalidTransition("Unknown task status: " + string(s))
	}
	return eventByTargetStatus[s], nil
}

// resolveEvent 复刻 JS 侧「传事件或传目标状态都行」的解析语义。
func resolveEvent(eventOrStatus TaskEvent) (TaskEvent, error) {
	if _, ok := Transitions[eventOrStatus]; ok {
		return eventOrStatus, nil
	}
	return EventForTargetStatus(TaskStatus(eventOrStatus))
}

// ResolveTransition 对应 TaskStateMachine.resolveTransition。
func ResolveTransition(current TaskStatus, eventOrStatus TaskEvent) (Resolution, error) {
	if !IsKnownStatus(current) {
		return Resolution{}, invalidTransition("Unknown current task status: " + string(current))
	}
	event, err := resolveEvent(eventOrStatus)
	if err != nil {
		return Resolution{}, err
	}
	transition, ok := getTransition(event)
	if !ok {
		return Resolution{}, invalidTransition("Unknown task event: " + string(event))
	}

	allowed := false
	for _, f := range transition.From {
		if f == current {
			allowed = true
			break
		}
	}
	target := transition.To

	res := Resolution{
		Allowed:    allowed,
		Event:      event,
		FromStatus: current,
		ToStatus:   target,
		Idempotent: current == target,
	}
	if !allowed {
		res.Reason = "Cannot transition task from " + string(current) + " to " +
			string(target) + " via " + string(event)
	}
	return res, nil
}

// AssertTransition 对应 TaskStateMachine.assertTransition。
func AssertTransition(current TaskStatus, eventOrStatus TaskEvent) (Resolution, error) {
	res, err := ResolveTransition(current, eventOrStatus)
	if err != nil {
		return res, err
	}
	if !res.Allowed {
		return res, invalidTransition(res.Reason)
	}
	return res, nil
}

// AllowedFromForEvent 对应 TaskStateMachine.allowedFromForEvent。
func AllowedFromForEvent(eventOrStatus TaskEvent) ([]TaskStatus, error) {
	event, err := resolveEvent(eventOrStatus)
	if err != nil {
		return nil, err
	}
	transition, ok := getTransition(event)
	if !ok {
		return nil, invalidTransition("Unknown task event: " + string(event))
	}
	return append([]TaskStatus(nil), transition.From...), nil
}

// TargetStatusForEvent 对应 TaskStateMachine.targetStatusForEvent。
func TargetStatusForEvent(eventOrStatus TaskEvent) (TaskStatus, error) {
	event, err := resolveEvent(eventOrStatus)
	if err != nil {
		return "", err
	}
	transition, ok := getTransition(event)
	if !ok {
		return "", invalidTransition("Unknown task event: " + string(event))
	}
	return transition.To, nil
}