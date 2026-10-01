package shadow

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

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
func ReadShadowCounts(ctx context.Context, client *redis.Client) (map[string]int, error) {
	raw, err := client.Get(ctx, ShadowCountsKey).Bytes()
	if err == redis.Nil {
		// Node 侧还没落盘(刚启动或窗口内没消息)。返回空而不是报错 ——
		// 「没数据」是影子验证初期的正常状态。
		return map[string]int{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("读影子计数失败: %w", err)
	}

	var raw2 map[string]float64
	if err := json.Unmarshal(raw, &raw2); err != nil {
		return nil, fmt.Errorf("解析影子计数失败: %w", err)
	}
	out := make(map[string]int, len(raw2))
	for k, v := range raw2 {
		out[k] = int(v)
	}
	return out, nil
}

// DiffAgainstNode 从 Redis 读 Node 侧计数,与本地观察做 diff。
func (o *Observer) DiffAgainstNode(ctx context.Context, client *redis.Client) (Diff, error) {
	nodeCounts, err := ReadShadowCounts(ctx, client)
	if err != nil {
		return Diff{}, err
	}

	goCounts := o.Snapshot()

	window := o.Summary().Window
	if window == "" {
		window = time.Duration(0).String()
	}
	return DiffSummaries(nodeCounts, goCounts, window), nil
}