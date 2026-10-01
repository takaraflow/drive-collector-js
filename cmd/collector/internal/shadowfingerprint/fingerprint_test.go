package shadowfingerprint

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

type vector struct {
	Name  string `json:"name"`
	Input struct {
		TypeID   string      `json:"typeId"`
		HasMedia bool        `json:"hasMedia"`
		TextLen  float64     `json:"textLen"`
		GroupID  interface{} `json:"groupId"`
	} `json:"input"`
	Expected string `json:"expected"`
}

func load(t *testing.T) []vector {
	t.Helper()
	p := filepath.Join("..", "..", "..", "..", "testdata", "shadow_fingerprint_vectors.json")
	raw, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("读取向量失败: %v", err)
	}
	var vs []vector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatalf("解析向量失败: %v", err)
	}
	return vs
}

// TestComputeMatchesJS 是影子比对能不能用的地基。
//
// 两边算出不同的指纹 = diff 全是噪声 = 比对毫无意义,而噪声会让人
// 误判「迁移不安全」并白折腾几周。这个测试就是防这个。
func TestComputeMatchesJS(t *testing.T) {
	vs := load(t)
	if len(vs) == 0 {
		t.Fatal("向量为空,需重跑 npm run test:vectors:shadow-fingerprint")
	}

	for _, v := range vs {
		t.Run(v.Name, func(t *testing.T) {
			groupID := ""
			if v.Input.GroupID != nil {
				groupID = groupIDToString(v.Input.GroupID)
			}
			got := Compute(Observation{
				TypeID:   v.Input.TypeID,
				HasMedia: v.Input.HasMedia,
				TextLen:  int(v.Input.TextLen),
				GroupID:  groupID,
			})
			if got != v.Expected {
				t.Errorf("Compute = %q\nJS   = %q", got, v.Expected)
			}
		})
	}
}

// groupIDToString 复刻 JS 的 String(x)。
// 媒体组 ID 在 gramjs 里可能是 number,Go 侧从 JSON 拿到的是 float64。
func groupIDToString(v interface{}) string {
	switch t := v.(type) {
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return ""
	}
}

// TestTypeIDFormatting TypeID 必须规整成 8 位小写十六进制 ——
// gramjs 给 number,Go 给 uint32,格式化不一致就对不上。
func TestTypeIDFormatting(t *testing.T) {
	if got := NormalizeTypeID(0x1f2b0afd); got != "1f2b0afd" {
		t.Errorf("NormalizeTypeID = %q,期望 \"1f2b0afd\"", got)
	}
	if got := NormalizeTypeID(0xa); got != "0000000a" {
		t.Errorf("短 TypeID 应补零到 8 位,得到 %q", got)
	}
}

// TestNegativeTextLen gramjs 空消息可能给出 -1,必须归零。
func TestNegativeTextLen(t *testing.T) {
	got := Compute(Observation{TypeID: "deadbeef", TextLen: -1})
	if got != "t=deadbeef|media=false|text=0|gid=" {
		t.Errorf("负数长度未归零: %q", got)
	}
}

// TestEmptyTypeIDVisible 取不到 TypeID 时必须显式留空,
// 不能伪装成某个具体类型。
func TestEmptyTypeIDVisible(t *testing.T) {
	if got := Compute(Observation{TypeID: "", TextLen: 1}); got != "t=|media=false|text=1|gid=" {
		t.Errorf("空 TypeID 未显式体现: %q", got)
	}
}

// TestDistinctInputsDistinctFingerprints 不同观察不能撞指纹 ——
// 撞了比对会漏掉差异,比报假差异更危险。
func TestDistinctInputsDistinctFingerprints(t *testing.T) {
	seen := map[string]string{}
	cases := []Observation{
		{TypeID: "1f2b0afd", TextLen: 1},
		{TypeID: "1f2b0afd", TextLen: 2},
		{TypeID: "1f2b0afd", TextLen: 1, HasMedia: true},
		{TypeID: "e40370a3", TextLen: 1},
		{TypeID: "1f2b0afd", TextLen: 1, GroupID: "g1"},
	}
	for _, o := range cases {
		fp := Compute(o)
		if prev, ok := seen[fp]; ok {
			t.Errorf("指纹碰撞: %+v 与 %s 得到同一个 %q", o, prev, fp)
		}
		seen[fp] = fmt.Sprintf("%+v", o)
	}
}