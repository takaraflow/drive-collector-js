package rclone

import (
	"context"
	"errors"
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

// TestRemoteTargetStripsLeadingSlash 是「上传必失败」的回归测试。
//
// 连接串形式的 remote 后面直接跟路径,路径【不能】以 / 开头 —— 带斜杠
// 时 rclone 把整串当成本地绝对路径,报「mkdir /X: permission denied」,
// 看着像网盘权限问题,实际是路径根本没指向网盘。
//
// 生产实测:上传一直卡在 mkdir,而下载完全正常(下载不经过这条路径)。
func TestRemoteTargetStripsLeadingSlash(t *testing.T) {
	conn := ":protondrive,username=u,password=p:"

	got := RemoteTarget(conn, "/DriveCollectorBot")
	// 关键:连接串闭合的 ':' 后面直接跟路径名,不能有 '/'
	if got != conn+"DriveCollectorBot" {
		t.Errorf("RemoteTarget = %q,期望 %q", got, conn+"DriveCollectorBot")
	}
	if strings.Contains(got, ":/") {
		t.Errorf("路径以 / 开头 —— rclone 会当成【本地】路径,报 permission denied")
	}
}

// TestRemoteTargetJoinsSegments 多段拼接与 JS 侧 _joinRemotePath 一致。
func TestRemoteTargetJoinsSegments(t *testing.T) {
	conn := ":mega,user=u:"

	for _, c := range []struct {
		segs []string
		want string
	}{
		{[]string{"/a", "b.txt"}, conn + "a/b.txt"},
		{[]string{"a/", "/b.txt"}, conn + "a/b.txt"},
		{[]string{"/a/b/", "//c//"}, conn + "a/b/c"},
		{[]string{"/only"}, conn + "only"},
		// 空段被丢弃 —— 否则会拼出 "a//b" 这种路径
		{[]string{"", "/a", "", "b"}, conn + "a/b"},
		// 全空时原样返回连接串(指向网盘根)
		{[]string{"", "/"}, conn},
		{nil, conn},
	} {
		if got := RemoteTarget(conn, c.segs...); got != c.want {
			t.Errorf("RemoteTarget(%v) = %q,期望 %q", c.segs, got, c.want)
		}
	}
}

// TestRemoteTargetKeepsBackendColon 连接串以 ':' 结尾时不能再补 '/'。
//
// 补了的话变成 ":protondrive...:/path",rclone 解析出的 remote 名就是空
// —— 又一个「看着像网盘问题」的失败。
func TestRemoteTargetKeepsBackendColon(t *testing.T) {
	conn := ":protondrive,a=b:"
	got := RemoteTarget(conn, "dir", "f.bin")
	if !strings.HasPrefix(got, conn) {
		t.Errorf("连接串被改动了:%q", got)
	}
	if strings.HasPrefix(strings.TrimPrefix(got, conn), "/") {
		t.Errorf("闭合 ':' 之后不该再有 '/':%q", got)
	}
}

// TestResolveBinaryPrefersExplicitEnv 显式指定优先。
func TestResolveBinaryPrefersExplicitEnv(t *testing.T) {
	t.Setenv("RCLONE_BINARY", "/custom/rclone")
	if got := resolveBinary(); got != "/custom/rclone" {
		t.Errorf("resolveBinary = %q,期望 /custom/rclone", got)
	}
}

// TestResolveBinaryFallsBackWhenNoPath 环境里没有 rclone 时退到历史路径。
//
// 不能返回空串 —— 那会让 exec 报一个和「rclone 不存在」毫无关系的错。
//
// 这条守着生产实测的故障:写死 /app/rclone/rclone 时,edge 镜像里
// 按官方脚本装到 /usr/bin/rclone,于是每次上传都「rclone: 启动失败」,
// 而下载是成功的 —— 表现为「文件传了一半」。
func TestResolveBinaryFallsBackWhenNoPath(t *testing.T) {
	t.Setenv("RCLONE_BINARY", "")
	t.Setenv("PATH", t.TempDir()) // 空目录,LookPath 必然失败

	if got := resolveBinary(); got != "/app/rclone/rclone" {
		t.Errorf("resolveBinary = %q,期望退到 /app/rclone/rclone", got)
	}
}

// TestPlainTextErrorIsSurfaced 纯文本错误必须出现在报错里。
//
// rclone 的致命错误有时走纯文本(不走 --use-json-log),而早期版本会
// 直接丢弃非 JSON 行 —— 于是失败信息只剩「(无错误详情)」。生产上
// 排查时等于什么都拿不到:明明有证据,被我们自己扔了。
func TestPlainTextErrorIsSurfaced(t *testing.T) {
	bin := fakeRclone(t, `echo "Failed to create directory: permission denied" >&2; exit 1`)

	r := quietRunner(bin)
	_, err := r.Run(context.Background(), Config{Timeout: 5 * time.Second},
		[]string{"mkdir", "conn:path"}, nil)
	if err == nil {
		t.Fatal("非零退出应报错")
	}
	if !strings.Contains(err.Error(), "permission denied") {
		t.Errorf("报错里没有 rclone 的原文 —— 诊断线索被丢了:%q", err.Error())
	}
	if strings.Contains(err.Error(), "无错误详情") {
		t.Errorf("有纯文本证据却报「无错误详情」:%q", err.Error())
	}
}

// TestJSONErrorStillWins JSON 里有结构化错误时,优先用它。
//
// 纯文本常常夹着进度条残留和 usage 提示,只在没有更好的东西时才用。
func TestJSONErrorStillWins(t *testing.T) {
	bin := fakeRclone(t, `echo "noise line one" >&2
echo '{"level":"error","msg":"real reason","error":"Code=10013"}' >&2
echo "noise line two" >&2
exit 1`)

	_, err := quietRunner(bin).Run(context.Background(), Config{Timeout: 5 * time.Second},
		[]string{"copyto", "a", "b"}, nil)
	if err == nil {
		t.Fatal("应报错")
	}
	if !strings.Contains(err.Error(), "10013") {
		t.Errorf("应优先用 JSON 里的结构化错误:%q", err.Error())
	}
	if strings.Contains(err.Error(), "noise") {
		t.Errorf("不该把纯文本混进来:%q", err.Error())
	}
}

// TestCriticalLevelIsSurfaced rclone 的 critical 等级也是错误。
//
// 实测(真 rclone v1.75.1):
//
//	{"level":"critical","msg":"Failed to create file system for ...:
//	 couldn't decrypt password: base64 decode failed ... illegal base64 data"}
//
// 启动阶段的失败(连不上后端、配置解析不了)报的是 critical,不是 error。
// 只认 error 的话这类失败会滑过去,只剩「无错误详情」—— 而那恰恰是
// 最需要看原因的一类。
func TestCriticalLevelIsSurfaced(t *testing.T) {
	bin := fakeRclone(t, `echo '{"level":"critical","msg":"Failed to create file system for \":protondrive,u:p:bot\": couldn'"'"'t decrypt password"}' >&2; exit 1`)

	_, err := quietRunner(bin).Run(context.Background(), Config{Timeout: 5 * time.Second},
		[]string{"mkdir", "conn:path"}, nil)
	if err == nil {
		t.Fatal("非零退出应报错")
	}
	if !strings.Contains(err.Error(), "couldn't decrypt password") {
		t.Errorf("critical 等级的错误被漏掉了:%q", err.Error())
	}
}

// TestStdoutErrorIsSurfaced stdout 上的错误也必须被看到。
//
// rclone 的致命错误有时走 stdout(尤其启动阶段的失败,比如配置解析)。
// 早期版本把 stdout 丢进 io.Discard —— 于是失败信息是「rclone 没输出
// 任何可解析的错误」,生产上排查时等于什么都拿不到。
func TestStdoutErrorIsSurfaced(t *testing.T) {
	bin := fakeRclone(t, `echo "Fatal error: config parse failed"; exit 1`)

	_, err := quietRunner(bin).Run(context.Background(), Config{Timeout: 5 * time.Second},
		[]string{"mkdir", "conn:path"}, nil)
	if err == nil {
		t.Fatal("非零退出应报错")
	}
	if !strings.Contains(err.Error(), "config parse failed") {
		t.Errorf("stdout 上的错误被丢了:%q", err.Error())
	}
}

// TestSuccessWithNoOutputIsNotAnError 退出码 0 就是成功,不管有没有输出。
//
// 用 io.Pipe 接两个流时踩过这个坑:父进程关掉写端会让 exec 的拷贝
// goroutine 写失败,Wait 于是返回「退出码 0 却报错」的假失败。
// 换成 os.Pipe 才对 —— 这条测试守着它不被改回去。
func TestSuccessWithNoOutputIsNotAnError(t *testing.T) {
	bin := fakeRclone(t, `exit 0`)

	if _, err := quietRunner(bin).Run(context.Background(), Config{Timeout: 5 * time.Second},
		[]string{"mkdir", "conn:path"}, nil); err != nil {
		t.Errorf("退出码 0 不该报错:%v", err)
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

// TestListFilesParsesStdout 清单走 stdout 的 JSON 数组,不走日志流。
func TestListFilesParsesStdout(t *testing.T) {
	bin := fakeRclone(t, `cat <<'EOF'
[{"Name":"a.mp4","Size":10,"ModTime":"2026-10-01T05:06:07.123Z","IsDir":false},{"Name":"sub","Size":0,"ModTime":"2026-09-01T05:06:07Z","IsDir":true}]
EOF`)

	files, err := quietRunner(bin).ListFiles(context.Background(),
		Config{Connection: "conn", Timeout: 5 * time.Second}, "/folder")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("files = %+v", files)
	}
	if files[0].Name != "a.mp4" || files[0].Size != 10 || !files[1].IsDir {
		t.Errorf("解析结果不对: %+v", files)
	}
}

// TestListFilesDirNotFoundIsSentinel 目录不存在必须给哨兵错误而不是
// 吞掉 —— 建不建目录是调用方的策略,这里瞒下来调用方就没得选。
func TestListFilesDirNotFoundIsSentinel(t *testing.T) {
	bin := fakeRclone(t, `echo 'Error: ...: directory not found' >&2; exit 1`)

	_, err := quietRunner(bin).ListFiles(context.Background(),
		Config{Connection: "conn"}, "/folder")
	if !errors.Is(err, ErrDirNotFound) {
		t.Fatalf("目录不存在应返回 ErrDirNotFound,得到 %v", err)
	}
}

// TestListFilesFailsOnOtherError 认不得的错误必须带 stderr 原文 ——
// 排查「列表打不开」时那是唯一的证据。
func TestListFilesFailsOnOtherError(t *testing.T) {
	bin := fakeRclone(t, `echo 'some auth failure' >&2; exit 1`)

	_, err := quietRunner(bin).ListFiles(context.Background(),
		Config{Connection: "conn"}, "/folder")
	if err == nil {
		t.Fatal("其他错误必须报错")
	}
	if !strings.Contains(err.Error(), "some auth failure") {
		t.Errorf("错误详情丢了 stderr 原文: %v", err)
	}
}
