package rclone

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Runtime 是一次 rclone 调用的「可写配置」上下文。
//
// 为什么需要它:Proton 这类网盘【不能】用连接串调 rclone。
// 它的 session 是可旋转的 —— rclone 跑完会把 client_refresh_token
// 换掉(旧的立即作废),而这个新 token 必须写回数据库,否则下次
// 拿旧 token 去认证就是 Code=10013,账号砖化。
//
// 连接串形式(内联参数)没有回读的余地:参数传进去就没了,旋转后的
// token 只存在于 rclone 的临时 conf 里,进程退出即丢失。
//
// 所以流程是:
//
//	写临时 conf → 跑 rclone --config <conf> → 读回 conf 收割新 token
//
// 对应 JS 侧 _openUserRemoteRuntime 的 usesWritableConf 分支
// (src/services/rclone.js)。
type Runtime struct {
	// RemoteName 是 conf 里的段名,rclone 目标写成 "<name>:path"。
	RemoteName string
	// ConfigPath 是临时 conf 的路径。
	ConfigPath string

	dir      string
	mu       sync.Mutex
	disposed bool
}

// NewRuntime 把 entries 写进一个临时 rclone.conf。
//
// entries 是「段名 → 键值」,由调用方从网盘配置构造 —— 具体写哪些键
// 是各网盘自己的知识(Proton 写 session,别的可能只写用户名密码),
// rclone 层不猜。
func NewRuntime(remoteName string, entries map[string]string) (*Runtime, error) {
	dir, err := os.MkdirTemp("", "rclone-rt-")
	if err != nil {
		return nil, fmt.Errorf("rclone: 创建临时目录失败: %w", err)
	}

	path := filepath.Join(dir, "rclone.conf")
	body := buildConf(remoteName, entries)
	// 0600:conf 里有 session 凭据。
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		_ = os.RemoveAll(dir)
		return nil, fmt.Errorf("rclone: 写临时配置失败: %w", err)
	}

	return &Runtime{RemoteName: remoteName, ConfigPath: path, dir: dir}, nil
}

// Args 返回这次调用该带的 --config 参数。
//
// 与 Runner.Run 里硬写的 "--config /dev/null" 互斥 —— 调用方二选一。
func (rt *Runtime) Args() []string {
	return []string{"--config", rt.ConfigPath}
}

// Target 把路径拼成 rclone 目标("<remote>:path")。
//
// 与 RemoteTarget 同样的规则,只是 base 变成 "<name>:" 而不是连接串。
func (rt *Runtime) Target(segments ...string) string {
	return RemoteTarget(rt.RemoteName+":", segments...)
}

// ReadSection 读回 conf 里本段的内容。
//
// 跑完 rclone 之后必须调它 —— session 可能已经被 rclone 旋转过。
// 返回的 map 是【磁盘上的当前值】,不是当初写进去的。
func (rt *Runtime) ReadSection() (map[string]string, error) {
	rt.mu.Lock()
	defer rt.mu.Unlock()

	raw, err := os.ReadFile(rt.ConfigPath)
	if err != nil {
		return nil, fmt.Errorf("rclone: 读回配置失败: %w", err)
	}
	return parseConfSection(string(raw), rt.RemoteName), nil
}

// Dispose 删掉临时目录。
//
// 必须在 ReadSection 之后调 —— 先删就读不到旋转后的 token 了。
func (rt *Runtime) Dispose() {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.disposed {
		return
	}
	rt.disposed = true
	if rt.dir != "" {
		_ = os.RemoveAll(rt.dir)
	}
}

// buildConf 生成 rclone.conf 的单个段。
//
// 键排序后输出 —— 让生成的 conf 稳定可 diff,排查时少一个变量。
func buildConf(remoteName string, entries map[string]string) string {
	var b strings.Builder
	b.WriteString("[" + remoteName + "]\n")

	keys := make([]string, 0, len(entries))
	for k := range entries {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	for _, k := range keys {
		v := entries[k]
		if v == "" {
			// 空值不写 —— 对应 JS 侧跳过 undefined/null/'' 的分支。
			// 写了空值反而会让 rclone 覆盖掉它自己的默认值。
			continue
		}
		b.WriteString(k + " = " + escapeConfValue(v) + "\n")
	}
	return b.String()
}

// escapeConfValue 按 rclone 的 conf 语法转义。
//
// 含空格、引号、反斜杠的值必须整体加引号,内部的反斜杠和双引号再转义 ——
// 少一步会让密码里的 " 截断整个值,而这【不报错】,只是认证失败。
func escapeConfValue(v string) string {
	if v == "" {
		return ""
	}
	needsQuote := strings.ContainsAny(v, " \t\"'\\#;")
	if !needsQuote {
		return v
	}
	escaped := strings.ReplaceAll(v, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	return `"` + escaped + `"`
}

// parseConfSection 取出指定段落的键值。
//
// 只认最简单的 `key = value` 形式 —— rclone 自己写出来的 conf 就是这个
// 形状,多余的语法(多行值等)它不会生成。故意不引 ini 库:几十行的
// 解析换一个依赖不划算,而且出问题时这一小段更容易看懂。
func parseConfSection(text, remoteName string) map[string]string {
	out := map[string]string{}
	inSection := false

	for _, rawLine := range strings.Split(text, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			inSection = strings.TrimSpace(line[1:len(line)-1]) == remoteName
			continue
		}
		if !inSection {
			continue
		}
		eq := strings.Index(line, "=")
		if eq < 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		if key == "" {
			continue
		}
		out[key] = unquoteConfValue(val)
	}
	return out
}

// unquoteConfValue 去掉 rclone 写 conf 时加上的引号与转义。
//
// rclone 输出时可能加引号(值含特殊字符时),读回来必须还原 ——
// 否则存进数据库的 refresh_token 会带着一层引号,下次直接用就连不上。
func unquoteConfValue(v string) string {
	if len(v) < 2 || !strings.HasPrefix(v, `"`) || !strings.HasSuffix(v, `"`) {
		return v
	}
	inner := v[1 : len(v)-1]
	inner = strings.ReplaceAll(inner, `\"`, `"`)
	inner = strings.ReplaceAll(inner, `\\`, `\`)
	return inner
}
