// Package rclone 调度 rclone 子进程。
//
// 这里就是 Go 相对 Node 的真实收益所在:JS 侧 rclone.js 有 200 行
// timeout + SIGKILL 样板,Go 用 exec.CommandContext + context.WithTimeout
// 塌缩到几行 —— 超时、取消、进程组清理都由标准库处理。
//
// 但要说清楚:**数据不经过 Go 堆**。字节搬运在 rclone 进程里
// (而 rclone 本身就是 Go 写的)。所以这里的收益是代码可读性和
// 取消语义的正确性,不是吞吐量。
package rclone

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// Runner 执行 rclone 命令。
type Runner struct {
	// Binary 是 rclone 可执行文件路径。
	Binary string
	// Env 是传给子进程的环境。刻意不继承父进程全部环境 ——
	// 少一堆意外变量,排查时行为可预测。
	Env []string
}

// NewRunner 构造 Runner,按可靠性顺序解析 rclone 的位置。
//
// 顺序不能反:
//  1. RCLONE_BINARY —— 显式指定优先,谁设了谁说了算
//  2. PATH 上的 rclone —— 任何正常镜像都该有。edge 镜像按官方脚本
//     装到 /usr/bin/rclone,不查 PATH 就找不到
//  3. /app/rclone/rclone —— Node 镜像的历史约定,留着兼容
//
// 生产实测:写死 /app/rclone/rclone 导致每次上传都
// 「rclone: 启动失败」—— 而下载是成功的,所以表现为「文件传了一半」。
func NewRunner() *Runner {
	return &Runner{
		Binary: resolveBinary(),
		Env:    append(os.Environ(), "RCLONE_CONFIG_PASS="),
	}
}

// resolveBinary 见 NewRunner 的说明。
func resolveBinary() string {
	if bin := os.Getenv("RCLONE_BINARY"); bin != "" {
		return bin
	}
	if bin, err := exec.LookPath("rclone"); err == nil {
		return bin
	}
	return "/app/rclone/rclone"
}

// Config 是临时 rclone 配置的上下文。
//
// 两种传参方式,二选一:
//
//   - Connection:把连接串直接作为 remote 传命令行,配 --config /dev/null
//     避免它去读磁盘上的默认配置 —— 那会让「机器上碰巧有个 rclone.conf」
//     变成一个无法解释的变量。适用于静态凭据(Mega)。
//
//   - Runtime:写临时 conf 文件,跑完能把旋转过的 session 读回来。
//     适用于可旋转 session 的网盘(Proton)—— 连接串形式没有回读的余地,
//     新 token 会随进程退出一起丢失,下次拿旧 token 就是 Code=10013。
type Config struct {
	// Connection 是 drive.ConnectionString 拼出来的串。
	Connection string
	// Runtime 覆盖 Connection —— 有它时用它的 conf。
	Runtime *Runtime
	// Timeout 是这次操作的上限。
	Timeout time.Duration
}

// LogEntry 是 rclone --use-json-log 输出的一行。
type LogEntry struct {
	Level string  `json:"level"`
	Msg   string  `json:"msg"`
	Error string  `json:"error"`
	Obj   *LogObj `json:"obj"`
	Stats *Stats  `json:"stats"`
	Time  string  `json:"time"`
}

type LogObj struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type Stats struct {
	Bytes      int64   `json:"bytes"`
	TotalBytes int64   `json:"totalBytes"`
	Speed      float64 `json:"speed"`
}

// ProgressFunc 接收进度回调(0..1)。传输大文件时用于更新 UI。
type ProgressFunc func(ratio float64, bytesDone, bytesTotal int64)

// Run 执行一次 rclone 操作,返回解析后的日志条目。
//
// 超时和取消都由 ctx 控制,进程组会被一并杀掉 —— 只杀父进程会
// 留下孤儿 rclone 继续占着网络和磁盘。
func (r *Runner) Run(ctx context.Context, cfg Config, args []string, progress ProgressFunc) ([]LogEntry, error) {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 15 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()

	full := append(append(cfg.execArgs(), "--use-json-log"), args...)

	cmd := exec.CommandContext(runCtx, r.Binary, full...)
	cmd.Env = r.Env
	// 自己的进程组 —— 超时时连同子进程一起清理。
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		// 杀整个进程组,负的 pid 就是组号。
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}

	// stdout 和 stderr 都接进同一个管道。
	//
	// 不能只接 stderr:rclone 的致命错误有时走 stdout(尤其启动阶段
	// 的失败,比如配置解析),而早期版本把 stdout 丢进 io.Discard ——
	// 于是失败信息是「rclone 没输出任何可解析的错误」,生产上排查时
	// 等于什么都拿不到。
	//
	// 用 os.Pipe 而不是 io.Pipe:exec 会为每个 writer 起一个拷贝
	// goroutine,而 io.Pipe 的写端被父进程关掉后那些 goroutine 会
	// 写失败,Wait 于是返回一个「退出码 0 却报错」的假失败。
	// os.Pipe 的写端会被 dup 进子进程,父进程关掉自己的副本后,
	// 子进程退出时写端自然全关,读端拿到 EOF。
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, fmt.Errorf("rclone: 建管道失败: %w", err)
	}
	cmd.Stdout = pw
	cmd.Stderr = pw

	if err := cmd.Start(); err != nil {
		_ = pw.Close()
		_ = pr.Close()
		return nil, fmt.Errorf("rclone: 启动失败(%s): %w", r.Binary, err)
	}
	// 父进程必须关掉写端副本,否则 pr 永远等不到 EOF。
	_ = pw.Close()

	entries, rawLines, scanErr := scanLogs(pr, progress)

	waitErr := cmd.Wait()
	_ = pr.Close()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return entries, fmt.Errorf("rclone: %w", ctxErr)
	}
	if waitErr != nil {
		// 把 scanner 自己的错误也带上 —— 读流失败时 entries/raw 都是空的,
		// 于是报「没输出任何可解析的错误」,而真实原因是「我们没读到」。
		// 这两者排查方向完全不同,不能混成一句话。
		detail := summarizeErrors(entries, rawLines)
		if scanErr != nil {
			detail = fmt.Sprintf("%s(读取输出时出错: %v)", detail, scanErr)
		}
		return entries, fmt.Errorf("rclone: 执行失败(退出码 %d): %s",
			cmd.ProcessState.ExitCode(), detail)
	}
	return entries, scanErr
}

// scanLogs 解析 rclone 的 stderr。
//
// rclone 把人类可读的日志和进度都写在 stderr 上,用 --use-json-log
// 之后每行是一个 JSON —— 沿用 JS 侧同样的做法,免得再造一个解析器。
//
// 返回两组东西:解析成功的 JSON 条目,以及【原样的非 JSON 行】。
//
// 后者必须留着:rclone 的致命错误有时走纯文本,而它往往是唯一的诊断
// 依据。早期版本直接丢弃它们,于是失败信息只剩「(无错误详情)」——
// 生产上排查时等于什么都拿不到。
func scanLogs(r io.Reader, progress ProgressFunc) (entries []LogEntry, raw []string, err error) {
	scanner := bufio.NewScanner(r)
	// rclone 的单行 JSON 可能很长(进度对象里字段多),默认 64KB 不够。
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry LogEntry
		if uerr := json.Unmarshal([]byte(line), &entry); uerr != nil {
			// 不是 JSON —— rclone 有些警告走纯文本。不该因此中断,
			// 也不能丢掉:失败时它就是唯一的证据。
			raw = append(raw, line)
			continue
		}
		entries = append(entries, entry)

		if progress != nil && entry.Stats != nil && entry.Stats.TotalBytes > 0 {
			progress(float64(entry.Stats.Bytes)/float64(entry.Stats.TotalBytes),
				entry.Stats.Bytes, entry.Stats.TotalBytes)
		}
	}
	return entries, raw, scanner.Err()
}

// isErrorLevel 判断 rclone 的日志等级是否代表失败。
//
// rclone 用的等级比想象的多:除了 error 还有 critical 和 fatal。
// 启动阶段的失败(连不上后端、配置解析不了)报的是 critical ——
// 只认 error 会把这些漏掉,而它们恰恰是最需要看原因的。
func isErrorLevel(level string) bool {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "error", "critical", "fatal", "panic":
		return true
	}
	return false
}

// summarizeErrors 从日志里提炼失败原因。
//
// raw 是非 JSON 行 —— 只有在 JSON 里找不到任何错误时才回头看它们。
// 顺序不能反:JSON 里的 error 字段是结构化的、干净;纯文本常常夹着
// 进度条残留和使用提示,只在没有更好的东西时才用。
func summarizeErrors(entries []LogEntry, raw []string) string {
	var errs []string
	for _, e := range entries {
		// critical / fatal 也算 —— rclone 在【启动阶段】失败(连不上
		// 后端、配置解析不了)时用的是 "critical",不是 "error"。
		// 只认 error 的话这类失败会滑过去,只剩「无错误详情」,
		// 而那恰恰是最需要看原因的一类。
		if isErrorLevel(e.Level) || e.Error != "" {
			msg := e.Error
			if msg == "" {
				msg = e.Msg
			}
			if msg != "" {
				errs = append(errs, msg)
			}
		}
	}
	if len(errs) > 0 {
		return strings.Join(errs, "; ")
	}

	// JSON 里没有错误 —— 用纯文本,取最后几行(最接近退出点)。
	if n := len(raw); n > 0 {
		start := n - 5
		if start < 0 {
			start = 0
		}
		return strings.Join(raw[start:], " | ")
	}
	return "(无错误详情:rclone 没输出任何可解析的错误)"
}

// RemoteTarget 把连接串和路径拼成 rclone 认识的完整目标。
//
// 连接串形式的 remote(`:backend,param=value:`)后面【直接跟路径】,
// 路径不能以 / 开头 —— 带斜杠时 rclone 把整串当成【本地绝对路径】,
// 报出来的错是「mkdir /X: permission denied」,看着像网盘权限问题,
// 实际是路径根本没指向网盘。
//
// 生产实测:上传一直失败在 mkdir,而下载完全正常 —— 因为下载用的是
// message 里的 location,不经过这条路径。
//
// 拼接规则与 JS 侧 _joinRemotePath 逐字对应(见 src/services/rclone.js):
// 段的前后斜杠都剥掉,空段丢弃,连接串本身以 ':' 或 '/' 结尾时不补分隔符。
func RemoteTarget(connection string, segments ...string) string {
	base := strings.TrimSpace(connection)

	cleaned := make([]string, 0, len(segments))
	for _, s := range segments {
		s = strings.Trim(s, "/")
		if s != "" {
			cleaned = append(cleaned, s)
		}
	}
	if len(cleaned) == 0 {
		return base
	}
	suffix := strings.Join(cleaned, "/")
	if strings.HasSuffix(base, ":") || strings.HasSuffix(base, "/") {
		return base + suffix
	}
	return base + "/" + suffix
}

// Upload 把本地文件传到 remote 路径。
//
// remotePath 是【不含连接串】的路径 —— 连接串由 cfg.Connection 提供,
// 在这里拼。让调用方拼的话,每个调用点都要记得拼一次,漏一个就是
// 「路径被当成本地目录」这种极难定位的故障。
func (r *Runner) Upload(ctx context.Context, cfg Config, localPath, remotePath string, progress ProgressFunc) error {
	_, err := r.Run(ctx, cfg, []string{"copyto", localPath, cfg.target(remotePath), "--progress"}, progress)
	return err
}

// Mkdir 确保远端目录存在。
func (r *Runner) Mkdir(ctx context.Context, cfg Config, remotePath string) error {
	_, err := r.Run(ctx, cfg, []string{"mkdir", cfg.target(remotePath)}, nil)
	return err
}

// target 把远端路径拼成 rclone 认识的目标。
//
// 有两种 base:连接串(Mega)或临时 conf 的段名(Proton)。调用方
// 只管传路径,拼法由这里统一决定 —— 让调用方拼的话每个调用点都要
// 记得拼一次,漏一个就是把网盘路径当成本地目录。
func (c Config) target(remotePath string) string {
	if c.Runtime != nil {
		return c.Runtime.Target(remotePath)
	}
	return RemoteTarget(c.Connection, remotePath)
}

// ListRemote 列远端目录,用于确认上传是否真的落地。
func (r *Runner) ListRemote(ctx context.Context, cfg Config, remotePath string) ([]string, error) {
	cfg.Timeout = 30 * time.Second
	entries, err := r.Run(ctx, cfg, []string{"lsjson", cfg.target(remotePath), "--max-depth", "1"}, nil)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if e.Level != "info" || e.Msg != "lsjson" || e.Obj == nil {
			continue
		}
		if e.Obj.Name != "" {
			names = append(names, e.Obj.Name)
		}
	}
	return names, nil
}

// Validate 校验配置是否可用 —— 用户绑定网盘时的即时反馈。
func (r *Runner) Validate(ctx context.Context, conn string) error {
	_, err := r.Run(ctx, Config{Timeout: 30 * time.Second},
		[]string{"lsjson", conn, "--max-depth", "1", "--timeout", "15s"}, nil)
	return err
}

// FileEntry 是 lsjson 清单里的一条(字段名与 rclone lsjson 的输出一致)。
type FileEntry struct {
	Name    string `json:"Name"`
	Size    int64  `json:"Size"`
	ModTime string `json:"ModTime"`
	IsDir   bool   `json:"IsDir"`
	// Path 是相对远端根的路径,只有 --recursive 的清单才会填。
	// /files 不用它,所以这里是可选的。
	Path string `json:"Path"`
	// Hashes 是 {算法名: 值}。后端不支持内容哈希时为空 —— 上层必须把
	// 「没有哈希」这件事传出去,否则会把「按大小归组」误报成「无重复」。
	Hashes map[string]string `json:"Hashes"`
}

// ErrDirNotFound 表示远端目录还不存在 —— 新用户没传过任何东西时的
// 正常形态。不吞掉它:建不建目录、建完还看不到算不算错,是调用方的
// 策略(JS 侧是顺手 mkdir 再试一次)。
var ErrDirNotFound = errors.New("rclone: 目录不存在")

// ListFiles 列远端目录,带 Name/Size/ModTime/IsDir —— /files 的数据源。
func (r *Runner) ListFiles(ctx context.Context, cfg Config, remotePath string) ([]FileEntry, error) {
	return r.lsjson(ctx, cfg, remotePath)
}

// ScanFiles 递归列整个网盘并带上内容哈希 —— /scan_dup 的数据源。
//
// --files-only 让 rclone 直接不给目录项;--hash 才有判重依据。
// 两者都缺的话,页面只能报「按大小归组」,等于没扫。
func (r *Runner) ScanFiles(ctx context.Context, cfg Config, remotePath string) ([]FileEntry, error) {
	return r.lsjson(ctx, cfg, remotePath, "-R", "--files-only", "--hash")
}

// lsjson 跑一次 lsjson 并收 stdout。
//
// 刻意不走 Run:lsjson 的清单是【命令输出】,写在 stdout;而 Run 把
// stdout+stderr 合进同一条 JSON 日志流,清单行会解析不成 LogEntry
// 而被当成「无法解析的行」丢掉。所以像 Obscure 一样直接 exec、
// 单独收 stdout。
func (r *Runner) lsjson(ctx context.Context, cfg Config, remotePath string, extra ...string) ([]FileEntry, error) {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 30 * time.Second
	}
	runCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()

	args := append(cfg.execArgs(), "lsjson")
	args = append(args, extra...)
	args = append(args, cfg.target(remotePath))
	cmd := exec.CommandContext(runCtx, r.Binary, args...)
	cmd.Env = r.Env
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if runCtx.Err() != nil {
		return nil, fmt.Errorf("rclone: lsjson 超时: %w", runCtx.Err())
	}
	if err != nil {
		detail := strings.TrimSpace(stderr.String())
		if detail == "" {
			detail = err.Error()
		}
		if isDirNotFound(detail) {
			return nil, ErrDirNotFound
		}
		return nil, fmt.Errorf("rclone: lsjson 失败: %s", detail)
	}
	var files []FileEntry
	if err := json.Unmarshal(out, &files); err != nil {
		return nil, fmt.Errorf("rclone: 解析 lsjson 输出失败: %w", err)
	}
	return files, nil
}

// isDirNotFound 判断错误详情是不是「目录不存在」。
//
// rclone 的原文是 "directory not found",个别后端报 "no such directory"。
// 认不全的代价是:每个还没传过东西的新用户,第一次 /files 就看到报错。
func isDirNotFound(detail string) bool {
	d := strings.ToLower(detail)
	return strings.Contains(d, "directory not found") ||
		strings.Contains(d, "no such directory")
}

// execArgs 返回这次调用该带的 --config 参数。
//
// 语义与 Run 里一致:不让 rclone 去读机器上碰巧存在的默认配置;
// 有可写 Runtime 时改用它的临时 conf(Proton 要回读旋转后的 session)。
func (c Config) execArgs() []string {
	if c.Runtime != nil {
		return c.Runtime.Args()
	}
	return []string{"--config", "/dev/null"}
}

// Version 返回 rclone 的版本首行 —— /diagnosis 的体检项。
//
// 走裸 exec 而不是 Run:Run 的管道只收 --use-json-log 的日志流,
// 而 `rclone version` 的版本号在 stdout 上,会被整条丢掉。
func (r *Runner) Version(ctx context.Context) (string, error) {
	cmd := exec.CommandContext(ctx, r.Binary, "--config", "/dev/null", "version")
	cmd.Env = r.Env
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("rclone: version 失败: %w", err)
	}
	// 输出形如 "rclone v1.68.2\n- ..."，取第一行就是版本号。
	first, _, _ := strings.Cut(strings.TrimSpace(string(out)), "\n")
	if first == "" {
		return "", fmt.Errorf("rclone: version 返回空输出")
	}
	return first, nil
}

// Obscure 调 rclone obscure 混淆密码。
//
// 与 JS 侧 CloudTool._obscureRequired 一致:出错的密码绝不能落库 ——
// 返回原值会让 rclone 反解出垃圾,症状是「配置对却连不上」。
func (r *Runner) Obscure(ctx context.Context, password string) (string, error) {
	// obscure 的结果走 stdout 而不是 --use-json-log 的日志流。
	// 用裸 exec,不经过 Run —— 那个管道只收 JSON 日志。
	cmd := exec.CommandContext(ctx, r.Binary, "--config", "/dev/null", "obscure", "--", password)
	cmd.Env = r.Env
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("rclone: obscure 失败: %w", err)
	}
	obscured := strings.TrimSpace(string(out))
	if obscured == "" {
		return "", fmt.Errorf("rclone: obscure 返回了空密码")
	}
	return obscured, nil
}
