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
	"fmt"
	"log/slog"
	"time"
)

// SettingsKey 与 JS 侧 SettingsRepository.getSettingsKey 对应。
const SettingsKey = "setting:tg_bot_session"

// Observation 是一次观察到的 update 的最小摘要。
//
// 刻意只记「可比较的指纹」而非完整消息体:
//   - 完整消息体含用户内容,落盘等于建了个隐私黑洞
//   - 迁移要比的是「看到什么」,不是「内容是什么」
type Observation struct {
	At          time.Time      `json:"at"`
	SessionID   int            `json:"sessionId"`
	Kind        string         `json:"kind"`
	UpdateType  string         `json:"updateType"`
	DCID        int            `json:"dcId,omitempty"`
	Points      int            `json:"points"`
	Date        int            `json:"date,omitempty"`
	TextLen     int            `json:"textLen,omitempty"`
	HasMedia    bool           `json:"hasMedia"`
	GroupID     string         `json:"groupId,omitempty"`
	Fingerprint string         `json:"fingerprint"`
}

// Fingerprint 是 update 的稳定指纹:同一批消息在 Node 和 Go 两侧必须
// 算出同一个值,否则说明两边收到的不是同一批东西。
//
// 用「类型 + 点数 + 内容长度 + 媒体组 ID」而不是消息 ID —— 消息 ID
// 在 MTProto 层本来就该一致,但一旦不一致我们更想先知道「差在哪一维」。
func Fingerprint(o Observation) string {
	return fmt.Sprintf("%s|p%d|d%d|tl%d|media=%t|gid=%s",
		o.UpdateType, o.Points, o.DCID, o.TextLen, o.HasMedia, o.GroupID)
}

// Observer 汇总观察结果。
type Observer struct {
	Log    *slog.Logger
	Count  int
	ByType map[string]int
	First  time.Time
	Last   time.Time
}

func NewObserver(log *slog.Logger) *Observer {
	return &Observer{Log: log, ByType: map[string]int{}}
}

// Record 记录一次观察。只打印摘要,不打消息内容。
func (o *Observer) Record(obs Observation) {
	o.Count++
	o.ByType[obs.UpdateType]++
	if o.First.IsZero() {
		o.First = obs.At
	}
	o.Last = obs.At

	obs.Fingerprint = Fingerprint(obs)
	o.Log.Info("shadow update",
		"sessionId", obs.SessionID,
		"kind", obs.Kind,
		"updateType", obs.UpdateType,
		"dcId", obs.DCID,
		"points", obs.Points,
		"hasMedia", obs.HasMedia,
		"textLen", obs.TextLen,
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