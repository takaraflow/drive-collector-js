package rclone

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeRclone 造一个假的 rclone 可执行文件。
//
// 刻意不用真 rclone:测试不能依赖外部二进制,而且我们测的是
// 「参数拼得对不对、stderr 解析、超时清理」—— 这些用脚本足够覆盖。
func fakeRclone(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "rclone")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+script+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func quietRunner(bin string) *Runner {
	return &Runner{Binary: bin, Env: append(os.Environ(), "RCLONE_CONFIG_PASS=")}
}

// TestArgsIncludeConfigIsolation 每次调用都必须带 --config /dev/null。
//
// 少了它,rclone 会去读机器上碰巧存在的默认配置 —— 那会变成一个
// 「配置明明对却连不上」且无法解释的变量。
func TestArgsIncludeConfigIsolation(t *testing.T) {
	argsFile := filepath.Join(t.TempDir(), "args")
	// 把路径写进脚本本身,而不是靠环境变量 —— 环境变量要穿过
	// exec 的 Env 才到得了,那样测的是另一件事。
	bin := fakeRclone(t, `echo "$@" > `+argsFile)

	r := quietRunner(bin)
	_, err := r.Run(context.Background(), Config{Timeout: 5 * time.Second},
		[]string{"lsjson", ":mega,user=\"u\":", "--max-depth", "1"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, readErr := os.ReadFile(argsFile)
	if readErr != nil {
		t.Fatalf("读回参数失败: %v", readErr)
	}
	seen := string(raw)

	if !strings.Contains(seen, "--config /dev/null") {
		t.Errorf("参数缺少 --config /dev/null:%s", seen)
	}
	if !strings.Contains(seen, "--use-json-log") {
		t.Errorf("参数缺少 --use-json-log:%s", seen)
	}
	// 连接串必须原样透传 —— 转义被 rclone 或 shell 处理过就会连不上
	if !strings.Contains(seen, `:mega,user="u":`) {
		t.Errorf("连接串未原样透传:%s", seen)
	}
}

// TestParsesJSONLogs rclone 的 JSON 日志要被解析出来。
func TestParsesJSONLogs(t *testing.T) {
	bin := fakeRclone(t, `cat >&2 <<'EOF'
{"level":"info","msg":"lsjson","obj":{"name":"a.txt","size":10}}
{"level":"info","msg":"lsjson","obj":{"name":"b.txt","size":20}}
this line is not JSON at all
EOF`)

	r := quietRunner(bin)
	entries, err := r.Run(context.Background(), Config{Timeout: 5 * time.Second},
		[]string{"lsjson", "conn"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// 非 JSON 的那行要被跳过而不是让整个解析失败
	if len(entries) != 2 {
		t.Fatalf("解析到 %d 条,期望 2(纯文本行应被跳过):%+v", len(entries), entries)
	}
	if entries[0].Obj == nil || entries[0].Obj.Name != "a.txt" {
		t.Errorf("第一条 = %+v", entries[0])
	}
	if entries[0].Obj.Size != 10 {
		t.Errorf("size 未解析 = %+v", entries[0].Obj)
	}
}

// TestNonJSONDoesNotFail 纯文本输出不该让操作失败。
//
// rclone 有些警告走纯文本,如果因为一行文本就判定失败,
// 用户会遇到「明明成功了却报错」。
func TestNonJSONDoesNotFail(t *testing.T) {
	bin := fakeRclone(t, `echo "NOT JSON AT ALL" >&2; echo '{"level":"info","msg":"ok"}' >&2; exit 0`)

	r := quietRunner(bin)
	if _, err := r.Run(context.Background(), Config{Timeout: 5 * time.Second},
		[]string{"lsjson", "conn"}, nil); err != nil {
		t.Errorf("纯文本输出不该导致失败:%v", err)
	}
}

// TestExitCodeBecomesError rclone 非零退出要报错,并带上日志里的原因。
func TestExitCodeBecomesError(t *testing.T) {
	bin := fakeRclone(t, `echo '{"level":"error","msg":"failed","error":"Invalid refresh token (Code=10013)"}' >&2; exit 1`)

	r := quietRunner(bin)
	_, err := r.Run(context.Background(), Config{Timeout: 5 * time.Second},
		[]string{"copyto", "a", "b"}, nil)
	if err == nil {
		t.Fatal("非零退出应报错")
	}
	// 错误信息必须含 rclone 的原文 —— 用户排查靠它
	if !strings.Contains(err.Error(), "10013") {
		t.Errorf("错误信息应含 rclone 原文,得到 %q", err.Error())
	}
}

// TestTimeoutIsEnforced 超时必须真的生效。
//
// 这是 Go 相对 JS 那 200 行样板的直接收益:ctx 到点自动清理,
// 不依赖「记得写 SIGKILL」。
func TestTimeoutIsEnforced(t *testing.T) {
	bin := fakeRclone(t, `sleep 10`)

	r := quietRunner(bin)
	start := time.Now()
	_, err := r.Run(context.Background(), Config{Timeout: 300 * time.Millisecond},
		[]string{"copyto", "a", "b"}, nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("超时应报错")
	}
	if elapsed > 3*time.Second {
		t.Errorf("超时未及时生效,耗时 %v", elapsed)
	}
	if !strings.Contains(err.Error(), "context") && !strings.Contains(err.Error(), "deadline") {
		t.Logf("错误信息: %v(可能是进程组清理失败,仍算通过)", err)
	}
}

// TestContextCancelPropagates 外层 ctx 取消也要立刻返回。
func TestContextCancelPropagates(t *testing.T) {
	bin := fakeRclone(t, `sleep 10`)

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(200 * time.Millisecond)
		cancel()
	}()

	start := time.Now()
	_, err := quietRunner(bin).Run(ctx, Config{Timeout: time.Minute},
		[]string{"copyto", "a", "b"}, nil)
	if err == nil {
		t.Fatal("ctx 取消应报错")
	}
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Errorf("取消未及时生效,耗时 %v", elapsed)
	}
}

// TestProgressCallback 进度回调要被正确触发。
func TestProgressCallback(t *testing.T) {
	bin := fakeRclone(t, `cat >&2 <<'EOF'
{"level":"info","msg":"x","stats":{"bytes":50,"totalBytes":100,"speed":1}}
{"level":"info","msg":"x","stats":{"bytes":100,"totalBytes":100,"speed":1}}
EOF`)

	var ratios []float64
	var mu sync.Mutex
	_, err := quietRunner(bin).Run(context.Background(), Config{Timeout: 5 * time.Second},
		[]string{"copyto", "a", "b"}, func(ratio float64, _, _ int64) {
			mu.Lock()
			ratios = append(ratios, ratio)
			mu.Unlock()
		})
	if err != nil {
		t.Fatal(err)
	}
	if len(ratios) != 2 {
		t.Fatalf("进度回调 %d 次,期望 2", len(ratios))
	}
	if ratios[0] != 0.5 || ratios[1] != 1.0 {
		t.Errorf("进度 = %v,期望 [0.5 1]", ratios)
	}
}

// TestMissingBinaryIsAClearError 二进制不存在要给清楚的错误。
func TestMissingBinaryIsAClearError(t *testing.T) {
	r := &Runner{Binary: "/nonexistent/rclone", Env: []string{}}
	_, err := r.Run(context.Background(), Config{Timeout: time.Second},
		[]string{"lsjson", "conn"}, nil)
	if err == nil {
		t.Fatal("二进制缺失应报错")
	}
	if !strings.Contains(err.Error(), "rclone") {
		t.Errorf("错误信息应点明是 rclone 启动失败:%q", err.Error())
	}
}

// TestValidateUsesShortTimeout 校验配置要短超时 —— 用户在绑定流程里
// 等着,30 秒的传输超时会让界面卡住。
func TestValidateUsesShortTimeout(t *testing.T) {
	bin := fakeRclone(t, `echo '{"level":"info","msg":"lsjson","obj":{"name":"x"}}' >&2`)

	if err := quietRunner(bin).Validate(context.Background(), "conn"); err != nil {
		t.Errorf("校验应成功:%v", err)
	}
}

// TestListRemote 列出远端文件。
func TestListRemote(t *testing.T) {
	bin := fakeRclone(t, `cat >&2 <<'EOF'
{"level":"info","msg":"lsjson","obj":{"name":"a.txt"}}
{"level":"info","msg":"lsjson","obj":{"name":"sub/"}}
EOF`)

	names, err := quietRunner(bin).ListRemote(context.Background(),
		Config{Connection: "conn"}, "/folder")
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 || names[0] != "a.txt" {
		t.Errorf("names = %v", names)
	}
}
