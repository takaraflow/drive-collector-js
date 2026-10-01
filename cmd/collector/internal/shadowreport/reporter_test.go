package shadowreport

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/youngsx/drive-collector/cmd/collector/internal/shadow"
	"github.com/youngsx/drive-collector/cmd/collector/internal/shadowfingerprint"
)

func quiet() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

const testBaseUnix = 1767225600 // 2026-01-01 00:00:00 UTC

func obsAt(offsetMin int, typeID string, textLen int) shadow.Observation {
	return shadow.Observation{
		At:   time.Unix(testBaseUnix, 0).UTC().Add(time.Duration(offsetMin) * time.Minute),
		Kind: "UpdateNewMessage",
		Feature: shadowfingerprint.Observation{
			TypeID:  typeID,
			TextLen: textLen,
		},
	}
}

// TestReportWritesDiffToRedis 这是影子验证的闭环点:
// 结论必须落到 Redis 的 shadow:diff,外部(CI/脚本/人)才读得到。
func TestReportWritesDiffToRedis(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	obs := shadow.NewObserver(quiet())
	const n = 30
	for m := 1; m <= 4; m++ {
		for i := 0; i < n; i++ {
			obs.Record(obsAt(m, "1f2b0afd", 5))
		}
	}
	// 最后一分钟(base+4)是「当前分钟」,不计入窗口 —— Node 侧也看不到
	// 正在积累的这一分钟。所以窗口内是 3 × 30 = 90 条。
	fp := "t=1f2b0afd|media=false|text=5|gid="
	mr.Set(shadow.ShadowCountsKey, `{"`+fp+`":90}`)

	New(obs, rdb, quiet()).reportOnce(context.Background())

	raw, err := mr.Get(DiffKey)
	if err != nil {
		t.Fatalf("结论未写入 Redis: %v", err)
	}
	var payload struct {
		Diff   shadow.Diff    `json:"diff"`
		GoSide shadow.Summary `json:"goSide"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Diff.Match {
		t.Errorf("两侧一致时应 match=true,note=%q", payload.Diff.Note)
	}
	if payload.GoSide.Total != 4*n {
		t.Errorf("Go 侧累计 = %d,期望 %d", payload.GoSide.Total, 4*n)
	}
}

// TestReportSurvivesRedisFailure Redis 挂了不能影响影子客户端 ——
// 比对是旁路,不是主流程。
func TestReportSurvivesRedisFailure(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	obs := shadow.NewObserver(quiet())
	obs.Record(obsAt(1, "1f2b0afd", 5))

	mr.Close() // Redis 立刻不可用

	// 不应 panic —— Run 里 recover 之外,reportOnce 也要自己扛住
	New(obs, rdb, quiet()).reportOnce(context.Background())
}

// TestReportWithoutRedisStillLogs 没配 Redis 时降级为只打印本地观察,
// 但必须明确提示「无法比对」—— 否则操作者会误以为比对通过了。
func TestReportWithoutRedisStillLogs(t *testing.T) {
	var buf strings.Builder
	log := slog.New(slog.NewTextHandler(&buf, nil))

	obs := shadow.NewObserver(quiet())
	obs.Record(obsAt(1, "1f2b0afd", 5))

	New(obs, nil, log).reportOnce(context.Background())

	if !strings.Contains(buf.String(), "无法比对") {
		t.Errorf("应明确提示无法比对,实际日志:\n%s", buf.String())
	}
}

// TestFormatText 文本输出要能让人一眼看出哪类指纹不一致。
func TestFormatText(t *testing.T) {
	d := shadow.DiffSummaries(
		map[string]int{"t=aaa|media=false|text=0|gid=": 10, "t=bbb|media=false|text=0|gid=": 3},
		map[string]int{"t=aaa|media=false|text=0|gid=": 10, "t=ccc|media=false|text=0|gid=": 5},
		"2m0s",
	)
	out := FormatText(d)

	if !strings.Contains(out, "不匹配") {
		t.Errorf("应报告不匹配:\n%s", out)
	}
	if !strings.Contains(out, "t=bbb") || !strings.Contains(out, "t=ccc") {
		t.Errorf("两侧各自的独有项都应出现:\n%s", out)
	}
	if !strings.Contains(out, "!") {
		t.Errorf("差异项应有标记:\n%s", out)
	}
	// 一致的项不该被标 !
	for _, line := range strings.Split(out, "\n") {
		if strings.Contains(line, "t=aaa") && strings.HasPrefix(line, "!") {
			t.Errorf("一致的项被误标为差异:\n%s", out)
		}
	}
}

// TestFormatTextGreenPath 一致时输出要明确说「一致」。
func TestFormatTextGreenPath(t *testing.T) {
	const n = 30
	fp := "t=aaa|media=false|text=0|gid="
	d := shadow.DiffSummaries(
		map[string]int{fp: n}, map[string]int{fp: n}, "5m0s")
	if !d.Match {
		t.Fatalf("前提不成立:两侧一致应 match=true,note=%q", d.Note)
	}
	if !strings.Contains(FormatText(d), "一致") {
		t.Error("应报告一致")
	}
}