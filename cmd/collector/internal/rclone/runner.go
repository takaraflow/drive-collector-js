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
	"context"
	"encoding/json"
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

// NewRunner 构造 Runner,二进制路径从环境变量的常见位置里找。
func NewRunner() *Runner {
	bin := os.Getenv("RCLONE_BINARY")
	if bin == "" {
		bin = "/app/rclone/rclone"
	}
	return &Runner{Binary: bin, Env: append(os.Environ(), "RCLONE_CONFIG_PASS=")}
}

// Config 是临时 rclone 配置的上下文。
//
// rclone 支持把连接串直接作为 remote 传给命令行(我们用这种),
// 配 `--config /dev/null` 避免它去读磁盘上的默认配置 ——
// 那会让「机器上碰巧有个 rclone.conf」变成一个无法解释的变量。
type Config struct {
	// Connection 是 drive.ConnectionString 拼出来的串。
	Connection string
	// Timeout 是这次操作的上限。
	Timeout time.Duration
}

// LogEntry 是 rclone --use-json-log 输出的一行。
type LogEntry struct {
	Level   string  `json:"level"`
	Msg     string  `json:"msg"`
	Error   string  `json:"error"`
	Obj     *LogObj `json:"obj"`
	Stats   *Stats  `json:"stats"`
	Time    string  `json:"time"`
}

type LogObj struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type Stats struct {
	Bytes     int64   `json:"bytes"`
	TotalBytes int64  `json:"totalBytes"`
	Speed     float64 `json:"speed"`
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

	full := append([]string{"--config", "/dev/null", "--use-json-log"}, args...)

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

	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("rclone: 取 stderr 失败: %w", err)
	}
	cmd.Stdout = io.Discard

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("rclone: 启动失败(%s): %w", r.Binary, err)
	}

	entries, scanErr := scanLogs(stderr, progress)

	waitErr := cmd.Wait()
	if ctxErr := ctx.Err(); ctxErr != nil {
		return entries, fmt.Errorf("rclone: %w", ctxErr)
	}
	if waitErr != nil {
		return entries, fmt.Errorf("rclone: 执行失败(退出码 %d): %s",
			cmd.ProcessState.ExitCode(), summarizeErrors(entries))
	}
	return entries, scanErr
}

// scanLogs 逐行解析 rclone 的 JSON 日志。
//
// rclone 会把人类可读的日志和进度都写在 stderr 上,用 --use-json-log
// 之后每行是一个 JSON —— 这是 JS 侧用 --use-json-log 的理由,
// 这里沿用同样的做法,免得再造一个解析器。
func scanLogs(r io.Reader, progress ProgressFunc) ([]LogEntry, error) {
	var entries []LogEntry
	scanner := bufio.NewScanner(r)
	// rclone 的单行 JSON 可能很长(进度对象里字段多),默认 64KB 不够。
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry LogEntry
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			// 不是 JSON —— rclone 有些警告走纯文本,不该因此中断。
			continue
		}
		entries = append(entries, entry)

		if progress != nil && entry.Stats != nil && entry.Stats.TotalBytes > 0 {
			progress(float64(entry.Stats.Bytes)/float64(entry.Stats.TotalBytes),
				entry.Stats.Bytes, entry.Stats.TotalBytes)
		}
	}
	return entries, scanner.Err()
}

// summarizeErrors 把日志里的错误汇总成一句可读的话。
func summarizeErrors(entries []LogEntry) string {
	var errs []string
	for _, e := range entries {
		if e.Level == "error" || e.Error != "" {
			msg := e.Error
			if msg == "" {
				msg = e.Msg
			}
			if msg != "" {
				errs = append(errs, msg)
			}
		}
	}
	if len(errs) == 0 {
		return "(无错误详情)"
	}
	return strings.Join(errs, "; ")
}

// Upload 把本地文件传到 remote 路径。
func (r *Runner) Upload(ctx context.Context, cfg Config, localPath, remotePath string, progress ProgressFunc) error {
	_, err := r.Run(ctx, cfg, []string{"copyto", localPath, remotePath, "--progress"}, progress)
	return err
}

// Mkdir 确保远端目录存在。
func (r *Runner) Mkdir(ctx context.Context, cfg Config, remotePath string) error {
	_, err := r.Run(ctx, cfg, []string{"mkdir", remotePath}, nil)
	return err
}

// ListRemote 列远端目录,用于确认上传是否真的落地。
func (r *Runner) ListRemote(ctx context.Context, cfg Config, remotePath string) ([]string, error) {
	entries, err := r.Run(ctx, Config{Connection: cfg.Connection, Timeout: 30 * time.Second},
		[]string{"lsjson", cfg.Connection + remotePath, "--max-depth", "1"}, nil)
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