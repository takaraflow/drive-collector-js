// Package edge 是 Go 边缘节点:接管 QStash 任务 webhook 的接收与转发。
//
// 设计前提:本节点无状态。payload 里只有一个 taskId,权威状态在 D1。
// 写错了只需把 LB 路由指回 Node,零数据丢失 —— 这是「无缝替换线上
// 服务」的全部依据。
//
// 路由边界(QSTASH_PATH_TEMPLATE = /api/v2/tasks/${topic}):
//
//	/api/v2/tasks/*       本节点:验签 → 解析 → 转发 leader
//	/health /healthz      本节点 —— 平台探针必须能打到它,否则容器
//	                       被判定不健康并无限重启,而探针失败时
//	                       容器来不及打印任何有用日志
//	/version              本节点 —— 确认线上跑的是哪个版本
//	/api/v2/stream/*      不接管 —— 跨实例 chunk 中转协议仍在 Node
//	/api/v2/config/refresh 不接管
package edge

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/contract"
	"github.com/youngsx/drive-collector/cmd/collector/internal/leader"
	"github.com/youngsx/drive-collector/cmd/collector/internal/qstash"
)

// MaxBodyBytes 限制 webhook body 大小。任务 payload 只有几 KB,
// 1MB 足够宽松,又能挡住超大 body 打爆内存。
const MaxBodyBytes = 1 << 20

// Config 是边缘节点配置。
type Config struct {
	Port int
	Log  *slog.Logger
	// InstanceID 用于 x-forwarded-by-instance,便于在 Node 侧日志里
	// 区分请求来自哪个边缘节点。
	InstanceID string
	Receiver   *qstash.Receiver
	Leader     *leader.Resolver
	// SkipVerify 仅供本地调试,生产必须为 false。
	SkipVerify bool
	// Mode 是运行模式,仅用于 /version 回报。
	Mode string
	// Outbound 是转发用客户端。nil 时用带超时的默认客户端。
	Outbound *http.Client
}

// Server 是边缘 HTTP 服务。
type Server struct {
	cfg    Config
	mux    *http.ServeMux
	client *http.Client
}

func New(cfg Config) *Server {
	if cfg.Log == nil {
		cfg.Log = slog.Default()
	}
	if cfg.Port == 0 {
		cfg.Port = 7860
	}
	client := cfg.Outbound
	if client == nil {
		// 与 JS 侧 AbortSignal.timeout(15000) 对齐,并给连接池设上限 ——
		// 边缘节点会为每个请求新建到 leader 的连接,不给上限会在
		// leader 重启时堆积。
		client = &http.Client{Timeout: leader.Timeout}
	}

	s := &Server{cfg: cfg, mux: http.NewServeMux(), client: client}
	s.routes()
	return s
}

func (s *Server) routes() {
	// 健康与版本端点 —— 与 Node 侧路径逐字一致。
	//
	// 不能省:平台探针(Northflank / fly.io)打的就是 /health 和
	// /healthz。缺了它们,容器会被判定不健康并无限重启 ——
	// 而且探针失败时容器根本来不及打印任何有用日志。
	s.mux.HandleFunc("/health", s.handleHealth)
	s.mux.HandleFunc("/healthz", s.handleHealth)
	s.mux.HandleFunc("/version", s.handleVersion)

	s.mux.HandleFunc("/api/v2/tasks/", s.handleTask)

	// 其余路径一律 404,不静默接管 —— 静默接管会让「本该走 Node 的
	// 路径」在这里悄悄 404,比报错更难排查。
	s.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"success": false,
			"message": "not handled by edge node",
			"path":    r.URL.Path,
		})
	})
}

// handleHealth 存活探针。
//
// 只回答「进程还活着」,不查依赖 —— Redis/D1 挂了进程还在,
// 探针不该因为那个重启它。依赖健康由 /ready 之类表达,而 Node 侧
// 也没把两者分开。
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{
			"success": false, "message": "method not allowed",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

// handleVersion 返回构建身份,便于确认线上跑的是哪个版本。
func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{
			"success": false, "message": "method not allowed",
		})
		return
	}
	version := os.Getenv("APP_VERSION")
	if version == "" {
		version = "dev"
	}
	sha := os.Getenv("GIT_SHA")
	if sha == "" {
		sha = "unknown"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"version": version,
		"sha":     sha,
		"mode":    modeOf(s.cfg),
	})
}

// modeOf 报告当前运行模式 —— /version 能一眼看出这个实例是 edge 还是 worker。
func modeOf(cfg Config) string {
	if cfg.Mode != "" {
		return cfg.Mode
	}
	return "edge"
}

// handleTask 处理 /api/v2/tasks/{topic}。
func (s *Server) handleTask(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{
			"success": false, "message": "method not allowed",
		})
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBodyBytes))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"success": false, "message": "cannot read body",
		})
		return
	}

	// 签名里的 sub 必须是完整 URL(含 query),所以从原始请求重建,
	// 不能用 r.URL.String() —— 它不含 scheme 和 host。
	if err := s.verify(r, body); err != nil {
		s.cfg.Log.Warn("qstash signature rejected",
			"path", r.URL.Path, "err", err)
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"success": false, "message": "invalid signature",
		})
		return
	}

	var doc map[string]any
	if err := json.Unmarshal(body, &doc); err != nil {
		// 与 JS 侧 Invalid JSON → 400 对齐。
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"success": false, "message": "Invalid JSON",
		})
		return
	}

	payload := contract.ParseTaskQueuePayload(body, time.Now())
	s.cfg.Log.Info("task webhook",
		"path", r.URL.Path,
		"taskId", payload.TaskID,
		"groupId", payload.GroupID,
		"triggerSource", payload.Meta.TriggerSource,
		"instanceId", payload.Meta.InstanceID)

	// system-events 不需要 leader:它是本实例的媒体组 flush 事件,
	// 和 Telegram 锁无关。放行给 Node 处理即可。
	//
	// 其余 topic(download/upload/batch)必须找到 leader 才能处理 ——
	// MTProto 长连接只在持锁实例上,发错实例等于把任务丢进黑洞。
	base, err := s.cfg.Leader.BaseURL(r.Context())
	if !strings.HasSuffix(r.URL.Path, "/system-events") && (err != nil || base == "") {
		// 与 JS 侧 isNotTelegramLeaderResult 契约一致:找不到 leader 就
		// 回 503,让 QStash 稍后重试,而不是悄悄丢弃。
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"success": false, "message": "Not Leader",
		})
		return
	}
	s.forwardTo(w, r, base, body)
}

func (s *Server) verify(r *http.Request, body []byte) error {
	if s.cfg.SkipVerify {
		return nil
	}
	if s.cfg.Receiver == nil {
		return qstash.ErrInvalidSignature
	}
	sig := r.Header.Get("Upstash-Signature")
	if sig == "" {
		return qstash.ErrMalformedSignature
	}
	return s.cfg.Receiver.Verify(sig, body, fullURL(r))
}

// fullURL 重建签名所对应的完整 URL。
func fullURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}
	u := scheme + "://" + host + r.URL.RequestURI()
	return u
}

// forwardTo 把请求原样转给指定 base —— body 必须逐字节保持,否则
// 签名哈希不匹配,Node 侧会拒。
func (s *Server) forwardTo(w http.ResponseWriter, r *http.Request, base string, body []byte) {
	ctx, cancel := context.WithTimeout(r.Context(), leader.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		base+r.URL.RequestURI(), strings.NewReader(string(body)))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"success": false, "message": "forward build failed",
		})
		return
	}
	req.Header.Set("Content-Type", "application/json")
	if sig := r.Header.Get("Upstash-Signature"); sig != "" {
		req.Header.Set("Upstash-Signature", sig)
	}
	if ts := r.Header.Get("Upstash-Timestamp"); ts != "" {
		req.Header.Set("Upstash-Timestamp", ts)
	}
	if mid := r.Header.Get("Upstash-Message-Id"); mid != "" {
		req.Header.Set("Upstash-Message-Id", mid)
	}
	req.Header.Set("X-Forwarded-By-Instance", s.cfg.InstanceID)

	resp, err := s.client.Do(req)
	if err != nil {
		s.cfg.Log.Error("forward failed", "path", r.URL.Path, "err", err)
		// 转发失败必须让 QStash 重试,所以返回 5xx 而不是 200。
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"success": false, "message": "upstream unreachable",
		})
		return
	}
	defer resp.Body.Close()

	for k, vs := range resp.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func writeJSON(w http.ResponseWriter, code int, payload map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(payload)
}

// Handler 暴露路由,便于测试。
func (s *Server) Handler() http.Handler { return s.mux }
