//go:build rclone_integration

// 真进程级验证:取消之后 rclone 进程组到底死没死。
//
// 单测全是 mock —— mock 能证明「代码调了 Cancel」,证明不了「进程真的
// 没了」。这两件事在生产上分岔过:进程照跑到底、文件照传上云盘,而
// 用户看到的是「已取消」。所以这里拉真进程,盯 /proc 说话。
//
// 跑法:
//
//	RCLONE_BINARY=/path/to/rclone go test -tags rclone_integration \
//	  -run TestReal -v ./cmd/collector/internal/rclone/
//
// build tag 隔离:不加 tag 时 `go test ./cmd/...` 一个真进程都不拉。
//
// 为什么从 /proc 认进程、而不是让 Runner 返回 PID:Run 里 cmd 是局部
// 变量,为此加个返回值就是给生产代码开一个只为测试存在的口子。这里用
// 「每个测试一个唯一端口 / 一个唯一命令行」从外面认领,生产代码一行不动,
// 验的仍然是生产路径本身(NewRunner + Run)。
package rclone

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// /proc 探针
// ---------------------------------------------------------------------------

// procStat 读 /proc/<pid>/stat 里我们关心的三个字段。
//
// state 在 comm 之后 —— comm 是括号包裹的进程名,里面可能有空格甚至
// 括号,所以必须从【最后一个 ')'] 之后再切,否则名字里带括号的进程会被
// 切错位。
func procStat(pid int) (state string, ppid, pgrp int, ok bool) {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", 0, 0, false
	}
	s := string(b)
	i := strings.LastIndex(s, ")")
	if i < 0 {
		return "", 0, 0, false
	}
	f := strings.Fields(s[i+1:])
	if len(f) < 3 { // f[0]=state f[1]=ppid f[2]=pgrp
		return "", 0, 0, false
	}
	ppid, _ = strconv.Atoi(f[1])
	pgrp, _ = strconv.Atoi(f[2])
	return f[0], ppid, pgrp, true
}

// groupMembers 列出进程组 pgid 里的全部进程。
//
// 用 pgrp 字段筛而不是 pgrep:pgrep 匹配的是命令行,而这里要验的恰恰是
// 「同组的每一个成员」,包括那些命令行只是个裸 `sleep 300`、根本没法
// 用字符串认领的孙进程。
func groupMembers(pgid int) []int {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var out []int
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if _, _, g, ok := procStat(pid); ok && g == pgid {
			out = append(out, pid)
		}
	}
	return out
}

// alive 报告 pid 是否还在。僵尸也算「在」—— 僵尸正是要抓的失败。
func alive(pid int) bool {
	_, _, _, ok := procStat(pid)
	return ok
}

// waitGroupGone 轮询到进程组彻底清空,返回等了多久;超时返回 -1。
func waitGroupGone(pgid int, within time.Duration) time.Duration {
	start := time.Now()
	for time.Since(start) < within {
		if len(groupMembers(pgid)) == 0 {
			return time.Since(start)
		}
		time.Sleep(10 * time.Millisecond)
	}
	return -1
}

// readCmdline 读 /proc/<pid>/cmdline。参数是 NUL 分隔的,换成空格便于 contains。
func readCmdline(pid int) string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return ""
	}
	return strings.ReplaceAll(strings.TrimRight(string(b), "\x00"), "\x00", " ")
}

// dumpGroup 把组内成员的 pid + 命令行打出来,失败时用得上。
func dumpGroup(pgid int) map[int]string {
	out := map[int]string{}
	for _, p := range groupMembers(pgid) {
		out[p] = readCmdline(p)
	}
	return out
}

// selfPgid 返回本测试进程自己的进程组号。
func selfPgid() int {
	b, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		return 0
	}
	s := string(b)
	i := strings.LastIndex(s, ")")
	f := strings.Fields(s[i+1:])
	if len(f) < 3 {
		return 0
	}
	g, _ := strconv.Atoi(f[2])
	return g
}

// findByMarker 扫全 /proc,找命令行里含 marker 的那个进程。
//
// 必须扫全表而不是只扫本进程的组 —— Setpgid 生效后子进程【不在】本
// 进程的组里,只扫本组永远找不到它。
func findByMarker(marker string) int {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if strings.Contains(readCmdline(pid), marker) {
			return pid
		}
	}
	return 0
}

// freePort 借一个随机端口。用完就还,留了个理论上的 TOCTOU 窗口 ——
// 验证脚本,不是生产代码。
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("借端口失败: %v", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

// waitHTTP 轮询到 url 返回响应为止,返回状态行;超时返回空串。
//
// 不能只 GET 一次:认领到 pid 只证明 exec 成功,rclone 还要一会儿才
// bind 端口。一次 refused 说明不了「没活着」。
func waitHTTP(url string, within time.Duration) string {
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			return resp.Status
		}
		time.Sleep(50 * time.Millisecond)
	}
	return ""
}

// dropRcloneFlags 写一个把 rclone 专属参数剥掉再 exec 到 sh 的小壳。
//
// 为什么需要:Run 会无条件在命令前加 `--config /dev/null --use-json-log`,
// 而 dash/bash 把 `--config` 当成非法长选项直接退出 2(实测
// 「/bin/sh: 0: Illegal option --」)。所以拿 sh 当 Binary 时得先过一层。
//
// 用 exec 而不是再 fork 一次:exec 保留 pid,于是 cmd.Process.Pid 仍是
// 进程组组长,被验的「杀整个组」逻辑与 rclone 场景完全同形。
func dropRcloneFlags(t *testing.T, sh string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "shim.sh")
	script := "#!/bin/sh\nshift 3\nexec " + sh + " \"$@\"\n"
	if err := os.WriteFile(p, []byte(script), 0o755); err != nil {
		t.Fatalf("写 shim 失败: %v", err)
	}
	return p
}

// runAndWatch 起一次 Run,等子进程落地后认领它,把 pid 和 Run 的返回通道交出去。
//
// 返回的 wait 幂等:多次调用都返回同一个 error,不会在已消费后二次阻塞。
//
// t.Cleanup 里无条件 cancel + wait:测试中途 t.Fatalf 的话,ctx 没人取消,
// 子进程会被 init 收养变成孤儿 —— 首版就踩了这个,留下一堆还在 listen 的
// rclone。验证进程组清理的脚本自己漏进程,最讽刺。
func runAndWatch(t *testing.T, r *Runner, cfg Config, args []string, marker string) (int, context.CancelFunc, func() error) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := r.Run(ctx, cfg, args, nil)
		done <- err
	}()
	var once sync.Once
	var runErr error
	wait := func() error {
		once.Do(func() { runErr = <-done })
		return runErr
	}
	t.Cleanup(func() {
		cancel()
		_ = wait()
	})

	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if pid := findByMarker(marker); pid != 0 {
			return pid, cancel, wait
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("10s 内没在任何进程的命令行里找到 marker=%q", marker)
	return 0, nil, nil
}

// ---------------------------------------------------------------------------
// 1. 真 rclone:进程活着 → 取消 → 彻底消失 → 不留僵尸
// ---------------------------------------------------------------------------

// TestRealRcloneServeProcessGroupIsKilled 拿真的 rclone 常驻进程验:
// 起 → 活 → 取消 → 死 → 不留僵尸。
func TestRealRcloneServeProcessGroupIsKilled(t *testing.T) {
	bin := os.Getenv("RCLONE_BINARY")
	if bin == "" {
		t.Skip("设 RCLONE_BINARY 指向真的 rclone 二进制才跑(否则不起真进程)")
	}
	if _, err := os.Stat(bin); err != nil {
		t.Skipf("RCLONE_BINARY=%s 不存在: %v", bin, err)
	}

	// 生产构造函数(内部按 RCLONE_BINARY 解析)。
	r := NewRunner()
	if r.Binary != bin {
		t.Fatalf("NewRunner 解析到 %q,不是 RCLONE_BINARY 的 %q", r.Binary, bin)
	}

	dir := t.TempDir()
	port := freePort(t)
	addr := fmt.Sprintf("127.0.0.1:%d", port)

	pid, cancel, waitRun := runAndWatch(t, r, Config{Timeout: 5 * time.Minute},
		[]string{"serve", "http", "--addr", addr, dir}, addr)

	state, ppid, pgid, ok := procStat(pid)
	if !ok {
		t.Fatalf("进程 %d 刚起来就没了", pid)
	}
	t.Logf("起进程: pid=%d ppid=%d pgid=%d state=%s", pid, ppid, pgid, state)
	t.Logf("cmdline: %s", readCmdline(pid))

	// Setpgid 生效的直接证据:pgid 必须等于自己的 pid,且不等于父进程组。
	// 不成立的话,runner.go 里那个 syscall.Kill(-pid, ...) 杀的就不是自己
	// 的组 —— 整个取消语义当场失效。
	if pgid != pid {
		t.Fatalf("Setpgid 没生效:pgid=%d != pid=%d", pgid, pid)
	}
	if pgid == selfPgid() {
		t.Fatalf("子进程和测试进程同组(pgid=%d),说明 Setpgid 没起作用", pgid)
	}

	// 真活着:HTTP 有回音。
	// 要轮询 —— 认领到 pid 只说明 exec 成功,端口可能还没 bind。
	status := waitHTTP("http://"+addr+"/", 10*time.Second)
	if status == "" {
		t.Fatalf("10s 内 %s 一直不通,进程起来了但没服务", addr)
	}
	t.Logf("取消前 HTTP: %s (回音正常)", status)
	t.Logf("取消前进程组成员: %v", dumpGroup(pgid))

	// 显式拉长窗口,方便人在旁边敲 ps / pgrep -g 看活体。
	// 默认不设 —— CI 和随手跑都不该被这个拖慢。
	if d, err := time.ParseDuration(os.Getenv("RCLONE_IT_HOLD")); err == nil && d > 0 {
		t.Logf("RCLONE_IT_HOLD=%v —— 进程保持存活 %v,现在可以 ps -p %d / pgrep -g %d", d, d, pid, pgid)
		time.Sleep(d)
	}

	// ---- 取消 ----
	start := time.Now()
	cancel()
	runErr := waitRun()
	t.Logf("Run 返回: err=%v 耗时=%v", runErr, time.Since(start).Round(time.Millisecond))

	if !errors.Is(runErr, context.Canceled) {
		t.Errorf("Run 的 error 认不出是取消: %v", runErr)
	}

	// 僵尸检查:Run 里调过 cmd.Wait(),子进程应当已被回收,/proc 条目直接
	// 消失。这里若看到 Z,是 Wait 的问题。
	if st, _, _, ok := procStat(pid); ok {
		t.Errorf("Run 返回后 pid %d 仍在 /proc,state=%s —— 僵尸没被回收", pid, st)
	} else {
		t.Logf("Run 返回瞬间 pid %d 已从 /proc 消失(无僵尸)", pid)
	}

	// 进程组整体消失 —— 这才是「杀整个组」的判据。
	if gone := waitGroupGone(pgid, 5*time.Second); gone < 0 {
		t.Errorf("5s 内进程组 %d 仍未清空,残留:%v", pgid, dumpGroup(pgid))
	} else {
		t.Logf("进程组 %d 彻底清空,耗时 %v", pgid, gone.Round(time.Millisecond))
	}

	// 服务端口必须已经没人 listen 了。
	if c, derr := net.DialTimeout("tcp", addr, 300*time.Millisecond); derr == nil {
		_ = c.Close()
		t.Errorf("进程组没了但 %s 还能连上,有人还在 listen", addr)
	} else {
		t.Logf("%s 已拒绝连接(端口释放)", addr)
	}
}

// ---------------------------------------------------------------------------
// 2. 多成员进程组:rclone 自己不 fork,拿 sh 补上这一段
// ---------------------------------------------------------------------------

// TestRealProcessGroupKillsEveryMember 验「杀整个组」在组里有多于一个
// 进程时也成立。
//
// 为什么要这条:rclone 的 serve/copy 模式【不 fork 子进程】—— 上面那条
// 测下来组里只有一个成员,只证明了「杀掉了那一个」,证明不了「组里另外
// 那些也会死」。而生产里孤儿 rclone 的风险恰恰来自子孙进程。这里用
// /bin/sh -c 起两个后台 sleep 补上多成员的形态。
//
// 走的是同一个 Runner.Run、同一份 cmd.Cancel,只把 Binary 换成 sh ——
// 被验的进程组逻辑与二进制无关。
func TestRealProcessGroupKillsEveryMember(t *testing.T) {
	sh, err := exec.LookPath("/bin/sh")
	if err != nil {
		t.Skipf("没有 /bin/sh: %v", err)
	}
	r := &Runner{Binary: dropRcloneFlags(t, sh), Env: os.Environ()}

	// 三个成员:sh 自己 + 两个 sleep。
	const marker = "sleep 300 &"
	pid, cancel, waitRun := runAndWatch(t, r, Config{Timeout: 5 * time.Minute},
		[]string{"-c", "sleep 300 & sleep 300 & wait"}, marker)

	state, _, pgid, ok := procStat(pid)
	if !ok {
		t.Fatalf("进程 %d 刚起来就没了", pid)
	}
	if pgid != pid {
		t.Fatalf("Setpgid 没生效:pgid=%d pid=%d", pgid, pid)
	}
	members := groupMembers(pgid)
	if len(members) < 3 {
		t.Fatalf("组里只有 %d 个成员(%v),测不出多成员", len(members), dumpGroup(pgid))
	}
	t.Logf("取消前: pid=%d pgid=%d state=%s", pid, pgid, state)
	t.Logf("取消前进程组成员(%d 个): %v", len(members), members)
	for _, p := range members {
		t.Logf("  成员 pid=%d cmd=%q", p, readCmdline(p))
	}

	start := time.Now()
	cancel()
	runErr := waitRun()
	t.Logf("Run 返回: err=%v 耗时=%v", runErr, time.Since(start).Round(time.Millisecond))

	if !errors.Is(runErr, context.Canceled) {
		t.Errorf("Run 的 error 认不出是取消: %v", runErr)
	}

	// 每一个成员都得死 —— 包括那两个命令行完全一样的 sleep。
	// 这正是只杀父进程会漏掉的那两个。
	gone := waitGroupGone(pgid, 5*time.Second)
	if gone < 0 {
		leftover := groupMembers(pgid)
		t.Errorf("进程组 %d 仍有 %d 个成员没死:", pgid, len(leftover))
		for _, p := range leftover {
			st, _, _, _ := procStat(p)
			t.Errorf("  残留 pid=%d state=%s cmd=%q", p, st, readCmdline(p))
		}
		// 别给这台机器留垃圾。
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
		t.FailNow()
	}
	t.Logf("进程组 %d 的全部 %d 个成员在 %v 内消失", pgid, len(members), gone.Round(time.Millisecond))
}

// ---------------------------------------------------------------------------
// 3. 对照组:只杀父进程会留孤儿(证明上面两条不是自证)
// ---------------------------------------------------------------------------

// TestControlSingleProcessKillLeaksGrandchild 是对照组:只对父进程发
// SIGKILL(模拟没有进程组时的做法),看孙进程是不是真的活下来。
//
// 没有这条,上面两条绿了也只能说明「没写错」,说明不了「写法是关键」。
// 这条留下孤儿,才是有意义的证据。
func TestControlSingleProcessKillLeaksGrandchild(t *testing.T) {
	sh, err := exec.LookPath("/bin/sh")
	if err != nil {
		t.Skipf("没有 /bin/sh: %v", err)
	}

	cmd := exec.Command(sh, "-c", "sleep 300 & sleep 300 & echo $!; wait")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("StdoutPipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("启动失败: %v", err)
	}
	pgid := cmd.Process.Pid

	// 等 sh 把第一个孙进程的 pid 吐出来,确保孙进程真的起来了。
	buf := make([]byte, 16)
	n, _ := io.ReadFull(out, buf[:1])
	t.Logf("sh 报出的首个孙进程 pid: %q", strings.TrimSpace(string(buf[:n])))

	// 只杀父进程 —— 这就是「没有 Setpgid 时会写成的样子」。
	if err := cmd.Process.Kill(); err != nil {
		t.Fatalf("杀父进程失败: %v", err)
	}
	_ = cmd.Wait()

	time.Sleep(300 * time.Millisecond)
	members := groupMembers(pgid)
	t.Logf("只杀父进程(pid %d)之后,进程组 %d 还剩 %d 个成员:", cmd.Process.Pid, pgid, len(members))
	for _, p := range members {
		st, _, _, _ := procStat(p)
		t.Logf("  孤儿 pid=%d state=%s cmd=%q", p, st, readCmdline(p))
	}
	if len(members) == 0 {
		t.Logf("注意:孤儿没留下 —— 对照组在本环境不成立(可能被子收割器立刻回收)。" +
			"主测试的「组内多成员一起死」仍然是实测结论")
	} else {
		t.Logf("对照组成立:只杀父进程留下了 %d 个孤儿进程", len(members))
	}

	// 收场:把对照组的残留也清掉。
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
	_ = out.Close()
}
