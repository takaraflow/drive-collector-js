// Command collector 是 Go 边缘节点。
//
// 两种模式,由 RUN_MODE 决定:
//
//	edge(默认)  接管 QStash 任务 webhook 的接收与转发(/api/v2/tasks/*),
//	            其余路由仍由 Node 处理。两者并行,由 LB 按路径分流。
//	worker      完整的 Go worker:连 Telegram、建任务、下载、上传。
//
// 环境变量与 JS 侧读同一套,这样无缝替换时不需要改任何部署配置:
//
//	PORT                        监听端口(edge 默认 7861)
//	QSTASH_CURRENT_SIGNING_KEY  当前签名密钥(edge 必填)
//	QSTASH_NEXT_SIGNING_KEY     下一把签名密钥(轮换期用)
//	REDIS_URL / NF_REDIS_URL    查 leader 用
//	SETTING_TG_SESSION          gramjs session 字符串(worker 必填)
//	API_ID / API_HASH           Telegram 应用凭据(worker 必填)
//	CLOUDFLARE_D1_*             D1 凭据(worker 必填)
//	DOWNLOAD_DIR                下载落盘目录(默认 /tmp/downloads,与 Node 一致)
//	REMOTE_FOLDER               网盘上的保存目录
//	CLOUDFLARE_D1_*             D1 凭据(worker 必填)
//	DOWNLOAD_DIR                下载落盘目录(默认 /tmp/downloads,与 Node 一致)
//	REMOTE_FOLDER               网盘上的保存目录
//	INSTANCE_ID                 本实例标识,写进 X-Forwarded-By-Instance
//	EDGE_SKIP_SIGNATURE_VERIFY  仅本地调试,生产必须 false
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/app"
	"github.com/youngsx/drive-collector/cmd/collector/internal/d1"
	"github.com/youngsx/drive-collector/cmd/collector/internal/edge"
	"github.com/youngsx/drive-collector/cmd/collector/internal/leader"
	"github.com/youngsx/drive-collector/cmd/collector/internal/qstash"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	"github.com/youngsx/drive-collector/cmd/collector/internal/tgsession"
)

func main() {
	// healthcheck 子命令:给容器探针用。不读 RUN_MODE,也不加载任何配置 ——
	// 探针要的是「进程还活着」,不是「配置齐不齐」。
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		runHealthcheck()
		return
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	mode := os.Getenv("RUN_MODE")
	if mode == "" {
		mode = "edge"
	}

	var err error
	switch mode {
	case "edge":
		err = runEdge(log)
	case "worker":
		err = runWorker(log)
	default:
		err = errors.New("未知 RUN_MODE:" + mode + "(可选:edge / worker)")
	}

	if err != nil {
		log.Error("collector failed", "mode", mode, "err", err)
		os.Exit(1)
	}
}

// signalCtx 返回被 SIGINT/SIGTERM 取消的 context。
func signalCtx() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
}

func runEdge(log *slog.Logger) error {
	ctx, stop := signalCtx()
	defer stop()
	return serveEdge(ctx, log)
}

func serveEdge(ctx context.Context, log *slog.Logger) error {
	currentKey := os.Getenv("QSTASH_CURRENT_SIGNING_KEY")
	if currentKey == "" {
		// 缺签名密钥等于完全不验签,必须硬失败而不是降级放行。
		return errors.New("QSTASH_CURRENT_SIGNING_KEY 未配置,拒绝以不验签模式启动")
	}

	skipVerify := os.Getenv("EDGE_SKIP_SIGNATURE_VERIFY") == "true"
	if skipVerify {
		log.Warn("EDGE_SKIP_SIGNATURE_VERIFY=true —— 验签已关闭,禁止用于生产")
	}

	port := envInt("PORT", 7861)
	srv := edge.New(edge.Config{
		Port:       port,
		Log:        log,
		InstanceID: os.Getenv("INSTANCE_ID"),
		Receiver: &qstash.Receiver{
			CurrentSigningKey: currentKey,
			NextSigningKey:    os.Getenv("QSTASH_NEXT_SIGNING_KEY"),
		},
		Leader:     leader.NewResolverFromEnv(),
		SkipVerify: skipVerify,
	})

	httpSrv := &http.Server{
		Addr:              ":" + strconv.Itoa(port),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("edge node listening", "port", port, "instance", os.Getenv("INSTANCE_ID"))
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		log.Info("收到停止信号,开始优雅关闭")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(shutdownCtx); err != nil {
			return err
		}
		return nil
	}
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// runWorker 启动完整的 Go worker:连 Telegram、建任务、下载、上传。
//
// 与 edge 的关键区别:edge 只验签转发,worker 真的处理消息。
func runWorker(log *slog.Logger) error {
	ctx, stop := signalCtx()
	defer stop()

	sessionStr := os.Getenv("SETTING_TG_SESSION")
	if sessionStr == "" {
		return errors.New("SETTING_TG_SESSION 未配置 —— worker 模式需要已登录的 session 串")
	}
	parsed, err := tgsession.Parse(sessionStr)
	if err != nil {
		return errors.New("解析 session 失败: " + err.Error())
	}
	apiID, err := strconv.Atoi(os.Getenv("API_ID"))
	if err != nil || apiID == 0 {
		return errors.New("API_ID 未配置或不是合法数字")
	}

	// D1 是硬依赖 —— 没有它连任务都建不了,必须硬失败而不是降级。
	db, err := d1.New(d1.Config{
		AccountID:  os.Getenv("CLOUDFLARE_D1_ACCOUNT_ID"),
		DatabaseID: os.Getenv("CLOUDFLARE_D1_DATABASE_ID"),
		Token:      os.Getenv("CLOUDFLARE_D1_TOKEN"),
		Log:        log,
	})
	if err != nil {
		return fmt.Errorf("D1 配置不完整: %w", err)
	}

	application, err := app.New(app.Config{
		APIID:       apiID,
		APIHash:     os.Getenv("API_HASH"),
		Session:     parsed,
		DownloadDir: os.Getenv("DOWNLOAD_DIR"),
		RemoteBase:  os.Getenv("REMOTE_FOLDER"),
		Repo:        store.NewTaskRepository(db),
		Log:         log,
	})
	if err != nil {
		return err
	}

	log.Info("worker 模式启动",
		"dc", parsed.DCID,
		"下载目录", envOr("DOWNLOAD_DIR", app.DefaultDownloadDir))
	return application.Run(ctx)
}

// runHealthcheck 自检:请求本地 edge 端口,通了退 0。
//
// 刻意只查「HTTP 端口是否响应」,不查依赖(D1 / Redis / Telegram)——
// 那些挂了进程还在,探针不该把它重启;真正需要重启的是进程本身出问题。
func runHealthcheck() {
	port := envInt("PORT", 7861)

	// worker 模式不起 HTTP 端口。此时探针没有意义,直接成功 ——
	// 否则编排器会不停重启一个健康的 worker。
	if os.Getenv("RUN_MODE") == "worker" {
		os.Exit(0)
	}

	client := &http.Client{Timeout: 3 * time.Second}
	// 探针打自己的 /healthz:edge 模式会 404(那属于 Node),
	// 但「404」本身证明 HTTP 栈在工作,这就是我们要的。
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
	if err != nil {
		os.Exit(1)
	}
	resp.Body.Close()
	os.Exit(0)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
