package shadow

import (
	"strings"
	"testing"
)

// TestEmptyIsNeverMatch 是整套影子验证里最关键的一条断言。
//
// DiffSummaries 早期版本在两侧都是空 map 时,循环不执行,
// match 停在初始值 true —— 于是「Node 没落盘 + Go 刚启动」
// 报告「可以切流量」。这是最危险的假阳性:判据说 OK,
// 而实际上什么都没有比对过。
func TestEmptyIsNeverMatch(t *testing.T) {
	d := DiffSummaries(map[string]int{}, map[string]int{}, "")
	if d.Match {
		t.Error("两侧都空时绝不能报 Match=true —— 那是「可以切流量」的假绿灯")
	}
	if !strings.Contains(d.Note, "样本不足") {
		t.Errorf("应说明是样本不足,实际 note=%q", d.Note)
	}
}

// TestBelowThresholdNeverMatch 样本太少时同样不能给绿灯。
func TestBelowThresholdNeverMatch(t *testing.T) {
	node := map[string]int{"t=1f2b0afd|media=false|text=10|gid=": 3}
	goc := map[string]int{"t=1f2b0afd|media=false|text=10|gid=": 3}

	// 完全一致但只有 3 条 —— 一致不代表有统计意义
	d := DiffSummaries(node, goc, "")
	if d.Match {
		t.Errorf("样本量 %d 低于门槛 %d 时不该报 Match", 3, minSamples)
	}
}

// TestConsistentAboveThreshold 样本足够且完全一致才报绿。
func TestConsistentAboveThreshold(t *testing.T) {
	const n = 30
	fp := "t=1f2b0afd|media=false|text=10|gid="
	node := map[string]int{fp: n}
	goc := map[string]int{fp: n}

	d := DiffSummaries(node, goc, "15m0s")
	if !d.Match {
		t.Errorf("两侧一致且样本充足时应报 Match,实际 note=%q rows=%+v", d.Note, d.Rows)
	}
}

// TestCompositionDiffEvenWhenTotalsMatch 构成不同但总数相同 ——
// 这是最危险的情况,总��比对完全看不出来。
func TestCompositionDiffEvenWhenTotalsMatch(t *testing.T) {
	const n = 30
	a := "t=1f2b0afd|media=false|text=10|gid="
	b := "t=e40370a3|media=false|text=10|gid="

	// Node 收 A 30 条,Go 收 B 30 条:总数一样,构成完全不同
	node := map[string]int{a: n}
	goc := map[string]int{b: n}

	d := DiffSummaries(node, goc, "")
	if d.Match {
		t.Error("总数相同但构成不同,必须报不匹配")
	}
	if len(d.Rows) != 2 {
		t.Fatalf("应输出 2 行(两侧各一种),实际 %d", len(d.Rows))
	}
	for _, r := range d.Rows {
		if r.Delta == 0 {
			t.Errorf("指纹 %q 的 delta 为 0,说明没检出构成差异", r.Fingerprint)
		}
	}
}

// TestDeltaDirection delta = Go - Node,正数代表 Go 侧多。
func TestDeltaDirection(t *testing.T) {
	const n = 30
	fp := "t=1f2b0afd|media=false|text=10|gid="
	d := DiffSummaries(map[string]int{fp: n}, map[string]int{fp: n + 5}, "")
	if len(d.Rows) != 1 {
		t.Fatalf("应有 1 行,实际 %d", len(d.Rows))
	}
	if d.Rows[0].Delta != 5 {
		t.Errorf("delta = %d,期望 5(Go - Node)", d.Rows[0].Delta)
	}
	if d.Match {
		t.Error("Go 侧多 5 条应报不匹配")
	}
}

// TestRowsSorted 输出按指纹排序,便于人工阅读 diff。
func TestRowsSorted(t *testing.T) {
	const n = 30
	node := map[string]int{
		"t=ffffffff|media=false|text=1|gid=": n,
		"t=00000000|media=false|text=1|gid=": n,
		"t=88888888|media=false|text=1|gid=": n,
	}
	goc := map[string]int{}
	for k := range node {
		goc[k] = n
	}

	d := DiffSummaries(node, goc, "")
	for i := 1; i < len(d.Rows); i++ {
		if d.Rows[i-1].Fingerprint > d.Rows[i].Fingerprint {
			t.Errorf("Rows 未按指纹排序: %q 在 %q 之前",
				d.Rows[i-1].Fingerprint, d.Rows[i].Fingerprint)
		}
	}
}