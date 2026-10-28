// Package edge 是 Go 边缘节点:接管 QStash 任务 webhook 的接收与转发。
//
// 设计前提:本节点无状态。payload 里只有一个 taskId,权威状态在 D1。
// 写错了只需把 LB 路由指回 Node,零数据丢失 —— 这是「无缝替换线上
// 服务」的全部依据。
//
// 路由边界(QSTASH_PATH_TEMPLATE = /api/v2/tasks/${topic}):
//
//	/api/v2/tasks/*       本节点:验签 → 解析 → 转发 leader (或处理 /tasks/:taskId/retry)
//	/health /healthz      本节点 —— 平台探针必须能打到它,否则容器
//	                       被判定不健康并无限重启,而探针失败时
//	                       容器来不及打印任何有用日志
//	/version              本节点 —— 确认线上跑的是哪个版本
//	/api/v2/stream/*      不接管 —— 跨实例 chunk 中转协议仍在 Node
//	/api/v2/config/refresh 本节点 —— 接收配置刷新通知并触发热载
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

	// InstanceSecret 用于 /api/v2/config/refresh 与 /api/v2/tasks/:taskId/retry 的鉴权。
	InstanceSecret string
	// TaskRetrier 处理手动任务重试（若为 leader 或单机运行）。
	TaskRetrier func(ctx context.Context, taskID string) (bool, error)
	// OnConfigRefresh 处理配置刷新通知。
	OnConfigRefresh func(ctx context.Context) error
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
	s.mux.HandleFunc("/health", s.handleHealth)
	s.mux.HandleFunc("/healthz", s.handleHealth)
	s.mux.HandleFunc("/version", s.handleVersion)

	// 配置刷新通知端点
	s.mux.HandleFunc("/api/v2/config/refresh", s.handleConfigRefresh)

	// 任务相关端点 (/api/v2/tasks/* 包括 /retry 与 qstash webhooks)
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

func modeOf(cfg Config) string {
	if cfg.Mode != "" {
		return cfg.Mode
	}
	return "edge"
}

// handleConfigRefresh 接收配置刷新通知 (Webhook)。
func (s *Server) handleConfigRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{
			"success": false, "message": "method not allowed",
		})
		return
	}

	if s.cfg.InstanceSecret != "" && r.Header.Get("x-instance-secret") != s.cfg.InstanceSecret {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"success": false, "message": "Unauthorized",
		})
		return
	}

	if s.cfg.OnConfigRefresh != nil {
		if err := s.cfg.OnConfigRefresh(r.Context()); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false, "message": err.Error(),
			})
			return
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"success": true, "message": "Configuration reloaded",
	})
}

// handleTask 处理 /api/v2/tasks/*。区分重试接口与 QStash webhook。
func (s *Server) handleTask(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{
			"success": false, "message": "method not allowed",
		})
		return
	}

	// 1. 如果是任务重试接口 /api/v2/tasks/{taskId}/retry
	if strings.HasSuffix(r.URL.Path, "/retry") {
		s.handleTaskRetry(w, r)
		return
	}

	// 2. QStash 任务队列 webhook
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBodyBytes))
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"success": false, "message": "cannot read body",
		})
		return
	}

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

	base, err := s.cfg.Leader.BaseURL(r.Context())
	if !strings.HasSuffix(r.URL.Path, "/system-events") && (err != nil || base == "") {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"success": false, "message": "Not Leader",
		})
		return
	}
	s.forwardTo(w, r, base, body)
}

func (s *Server) handleTaskRetry(w http.ResponseWriter, r *http.Request) {
	if s.cfg.InstanceSecret != "" && r.Header.Get("x-instance-secret") != s.cfg.InstanceSecret {
		writeJSON(w, http.StatusUnauthorized, map[string]any{
			"success": false, "message": "Unauthorized",
		})
		return
	}

	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 4 || parts[len(parts)-1] != "retry" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"success": false, "message": "invalid retry path",
		})
		return
	}
	taskID := parts[len(parts)-2]
	if taskID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"success": false, "message": "missing taskId",
		})
		return
	}

	// 若本节点已提供 TaskRetrier，直接在当前节点重试
	if s.cfg.TaskRetrier != nil {
		ok, err := s.cfg.TaskRetrier(r.Context(), taskID)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"success": false, "message": err.Error(), "taskId": taskID,
			})
			return
		}
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]any{
				"success": false, "message": "task not found", "taskId": taskID,
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"success": true, "message": "Task queued for retry", "taskId": taskID,
		})
		return
	}

	// 否则若未被转发过，转发给 Telegram Leader
	if s.cfg.Leader != nil && r.Header.Get("X-Forwarded-By-Instance") == "" {
		base, err := s.cfg.Leader.BaseURL(r.Context())
		if err == nil && base != "" {
			body, _ := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxBodyBytes))
			s.forwardTo(w, r, base, body)
			return
		}
	}

	writeJSON(w, http.StatusServiceUnavailable, map[string]any{
		"success": false, "message": "No retrier available and not leader",
	})
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
	if sec := r.Header.Get("x-instance-secret"); sec != "" {
		req.Header.Set("x-instance-secret", sec)
	}
	req.Header.Set("X-Forwarded-By-Instance", s.cfg.InstanceID)

	resp, err := s.client.Do(req)
	if err != nil {
		s.cfg.Log.Error("forward failed", "path", r.URL.Path, "err", err)
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
