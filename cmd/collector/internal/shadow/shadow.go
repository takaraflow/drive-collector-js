// Package shadow 实现影子模式:Go 侧连接 Telegram,但绝不处理消息。
//
// 为什么需要它
//
// 迁移 Telegram 客户端最大的风险不是「跑不起来」,而是「跑起来了
// 但行为和 Node 不一样」——比如少了某个 update 类型、少了一条消息、
// 事件顺序不同。这类差异在线上要几天才暴露一次,代价太高。
//
// 影子模式把风险反过来:Go 和 Node 同时连着,Go 看到什么就记下来,
// 但一条都不处理。跑一段时间比对两边看到的 update 流,一致了才敢切。
//
// 三条铁律(改动前先读)
//
//  1. 不碰 telegram_client 锁 —— 那是 Node 的心跳来源。抢了会把
//     线上实例踢下线,触发 AUTH_KEY_DUPLICATED(记忆里的 PR#445/447)。
//  2. 不调任何有副作用的 API —— 不 sendMessage、不 markRead、
//     不 deleteMessages、不确认消息。看到的 update 一律丢弃。
//  3. 不写回 session —— session 是 Node 的。Go 侧改了会让 Node 下次
//     加载到不一致的 authKey。
//
// 只读,并且只读锁之外的东西。
package shadow

import (
	"encoding/json"
	"log/slog"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/shadowfingerprint"
)

// SettingsKey 与 JS 侧 SettingsRepository.getSettingsKey 对应。
const SettingsKey = "setting:tg_bot_session"

// Observation 是一次观察到的 update 的最小摘要。
//
// 刻意只记「可比较的指纹」而非完整消息体:
//   - 完整消息体含用户内容,落盘等于建了个隐私黑洞
//   - 迁移要比的是「看到什么」,不是「内容是什么」
type Observation struct {
	At      time.Time `json:"at"`
	Kind    string    `json:"kind"`
	Points  int       `json:"points"`
	Date    int       `json:"date,omitempty"`
	Session int       `json:"sessionId"`

	// Feature 是跨语言共享的指纹输入。用共享契约而不是本地字段 ——
	// 两份指纹实现必然漂移,而漂移的表现是「diff 全是噪声」。
	Feature shadowfingerprint.Observation `json:"feature"`

	// Fingerprint 由共享契约算出。
	Fingerprint string `json:"fingerprint"`
}


// Observer 汇总观察结果。
type Observer struct {
	Log    *slog.Logger
	Count  int
	ByType map[string]int
	// byFingerprint 是 diff 的数据基础:按共享指纹统计构成。
	byFingerprint map[string]int
	First time.Time
	Last  time.Time
}

func NewObserver(log *slog.Logger) *Observer {
	return &Observer{Log: log, ByType: map[string]int{}, byFingerprint: map[string]int{}}
}

// Record 记录一次观察。只打印摘要,不打消息内容。
func (o *Observer) Record(obs Observation) {
	o.Count++
	o.ByType[obs.Feature.TypeID]++
	if o.First.IsZero() {
		o.First = obs.At
	}
	o.Last = obs.At

	obs.Fingerprint = shadowfingerprint.Compute(obs.Feature)
	o.byFingerprint[obs.Fingerprint]++

	o.Log.Info("shadow update",
		"kind", obs.Kind,
		"points", obs.Points,
		"typeId", obs.Feature.TypeID,
		"fingerprint", obs.Fingerprint,
	)
}

// Summary 输出可与 Node 侧比对的摘要。
type Summary struct {
	Total    int            `json:"total"`
	ByType   map[string]int `json:"byType"`
	First    time.Time      `json:"first"`
	Last     time.Time      `json:"last"`
	Window   string         `json:"window"`
}

func (o *Observer) Summary() Summary {
	w := ""
	if !o.First.IsZero() {
		w = o.Last.Sub(o.First).String()
	}
	return Summary{
		Total:  o.Count,
		ByType: o.ByType,
		First:  o.First,
		Last:   o.Last,
		Window: w,
	}
}

// MarshalSummary 供调试端点使用。
func (o *Observer) MarshalSummary() ([]byte, error) {
	return json.MarshalIndent(o.Summary(), "", "  ")
}