package shadow

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/redis/go-redis/v9"
)

// ShadowCountsKey 与 Node 侧 ShadowRecorder 的 KEY 一致。
const ShadowCountsKey = "shadow:counts"

// Diff 是两侧计数比对的结果。
type Diff struct {
	Window string         `json:"window"`
	Rows   []DiffRow      `json:"rows"`
	Match  bool           `json:"match"`
	Note   string         `json:"note,omitempty"`
}

type DiffRow struct {
	Fingerprint string `json:"fingerprint"`
	Node        int    `json:"node"`
	Go          int    `json:"go"`
	Delta       int    `json:"delta"`
}

// DiffSummaries 比对 Node 与 Go 的影子计数。
//
// 这是「能不能切」的判据:
//   - Match=true  → 两边看到的 update 构成一致,可以进入下一阶段
//   - Match=false → 有差异,继续观察或查差异来源
//
// 刻意输出「逐指纹的 delta」而不是一个总数:总数一致但构成不同
// (Node 收了 10 条 A、0 条 B;Go 收了 0 条 A、10 条 B)是最危险的
// 情况,而它恰好在总数比对下看不出来。
// minSamples 是给出「可以切流量」结论所需的最小样本量。
const minSamples = 20

// DiffSummaries 比对 Node 与 Go 的影子计数。
//
// 这是「能不能切」的判据:
//   - Match=true  → 两边看到的 update 构成一致,可以进入下一阶段
//   - Match=false → 有差异,或样本不足,继续观察或查差异来源
//
// 刻意输出「逐指纹的 delta」而不是一个总数:总数一致但构成不同
// (Node 收了 10 条 A、0 条 B;Go 收了 0 条 A、10 条 B)是最危险的
// 情况,而它恰好在总数比对下看不出来。
func DiffSummaries(nodeCounts, goCounts map[string]int, window string) Diff {
	keys := map[string]bool{}
	for k := range nodeCounts {
		keys[k] = true
	}
	for k := range goCounts {
		keys[k] = true
	}

	sorted := make([]string, 0, len(keys))
	for k := range keys {
		sorted = append(sorted, k)
	}
	sort.Strings(sorted)

	rows := make([]DiffRow, 0, len(sorted))
	nodeTotal, goTotal := 0, 0
	match := true
	for _, fp := range sorted {
		n, g := nodeCounts[fp], goCounts[fp]
		nodeTotal += n
		goTotal += g
		row := DiffRow{Fingerprint: fp, Node: n, Go: g, Delta: g - n}
		if row.Delta != 0 {
			match = false
		}
		rows = append(rows, row)
	}

	note := "delta = Go - Node。非零即构成不一致,切流量前必须先解释清楚。"
	if nodeTotal < minSamples || goTotal < minSamples {
		match = false
		note = fmt.Sprintf(
			"样本不足(Node=%d, Go=%d,门槛=%d),无法据此判断 —— 一律记为不匹配。"+
				"两侧同时为空时 diff 会假报「可以切流量」,这是最危险的假阳性。",
			nodeTotal, goTotal, minSamples)
	}

	return Diff{Window: window, Rows: rows, Match: match, Note: note}
}

// ReadShadowCounts 读 Node 侧写的影子计数。
//
// 第二个返回值 present 区分两种「空」:
//   - present=false:Redis 里没这个 key —— Node 侧记录器没启动,
//     或窗口内确实一条都没记。判据绝不能把它当成「一致」。
//   - present=true 且 map 为空:key 存在但计数全零,属于正常空窗。
func ReadShadowCounts(ctx context.Context, client *redis.Client) (map[string]int, bool, error) {
	raw, err := client.Get(ctx, ShadowCountsKey).Bytes()
	if err == redis.Nil {
		return map[string]int{}, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("读影子计数失败: %w", err)
	}

	var decoded map[string]float64
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, false, fmt.Errorf("解析影子计数失败: %w", err)
	}
	out := make(map[string]int, len(decoded))
	for k, v := range decoded {
		out[k] = int(v)
	}
	return out, true, nil
}

// DiffAgainstNode 从 Redis 读 Node 侧计数,与本地窗口做 diff。
func (o *Observer) DiffAgainstNode(ctx context.Context, client *redis.Client) (Diff, error) {
	nodeCounts, present, err := ReadShadowCounts(ctx, client)
	if err != nil {
		return Diff{}, err
	}
	goCounts, _ := o.WindowedSnapshot()

	d := DiffSummaries(nodeCounts, goCounts, o.Summary().Window)
	if !present {
		d.Match = false
		d.Note = "Node 侧尚无影子记录(SHADOW_RECORD 未开启,或还没到第一次 flush)。" +
			"这不是「一致」,是「没数据可比」——绝不能据此切流量。"
	}
	if !o.Started() {
		d.Match = false
		d.Note = "Go 侧影子客户端还没收到任何 update(可能没连上)。" + d.Note
	}
	return d, nil
}