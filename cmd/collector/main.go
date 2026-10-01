// Command collector 是 Go 边缘节点。
//
// 三种模式,由 RUN_MODE 决定:
//
//	edge(默认)  接管 QStash 任务 webhook 的接收与转发(/api/v2/tasks/*),
//	            其余路由仍由 Node 处理。两者并行,由 LB 按路径分流。
//	shadow      Telegram 影子客户端:连上 Telegram、收到 update、记指纹,
//	            一条都不处理。用于验证「Go 看到的流和 Node 是否一致」。
//	both        上面两个同时跑(影子验证期间用)。
//
// 环境变量与 JS 侧读同一套,这样无缝替换时不需要改任何部署配置:
//
//	PORT                        监听端口(edge 默认 7861)
//	QSTASH_CURRENT_SIGNING_KEY  当前签名密钥(edge 必填)
//	QSTASH_NEXT_SIGNING_KEY     下一把签名密钥(轮换期用)
//	REDIS_URL / NF_REDIS_URL    查 telegram_client 锁用
//	SETTING_TG_SESSION          gramjs session 字符串(shadow 必填)
//	API_ID / API_HASH           Telegram 应用凭据(shadow 必填)
//	INSTANCE_ID                 本实例标识,写进 X-Forwarded-By-Instance
//	EDGE_SKIP_SIGNATURE_VERIFY  仅本地调试,生产必须 false
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/edge"
	"github.com/youngsx/drive-collector/cmd/collector/internal/leader"
	"github.com/youngsx/drive-collector/cmd/collector/internal/qstash"
	"github.com/youngsx/drive-collector/cmd/collector/internal/shadow"
	"github.com/youngsx/drive-collector/cmd/collector/internal/tgsession"
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	mode := os.Getenv("RUN_MODE")
	if mode == "" {
		mode = "edge"
	}

	var err error
	switch mode {
	case "edge":
		err = runEdge(log)
	case "shadow":
		err = runShadow(log)
	case "both":
		err = runBoth(log)
	default:
		err = errors.New("未知 RUN_MODE:" + mode + "(可选:edge / shadow / both)")
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

// runShadow 启动 Telegram 影子客户端。
//
// 它需要 Node 已登录的 session 字符串。刻意做成「从环境变量读」而不是
// 「自己去 Redis 读」:影子验证通常跑在一个独立容器里,让它能连生产
// Redis 就等于给了它写权限,而它一次都不该写。
func runShadow(log *slog.Logger) error {
	ctx, stop := signalCtx()
	defer stop()

	sessionStr := os.Getenv("SETTING_TG_SESSION")
	if sessionStr == "" {
		return errors.New("SETTING_TG_SESSION 未配置 —— 影子模式需要 Node 已登录的 session 串")
	}

	parsed, err := tgsession.Parse(sessionStr)
	if err != nil {
		return errors.New("解析 session 失败(格式应为 gramjs StringSession): " + err.Error())
	}

	apiID, err := strconv.Atoi(os.Getenv("API_ID"))
	if err != nil || apiID == 0 {
		return errors.New("API_ID 未配置或不是合法数字")
	}

	client, err := shadow.New(shadow.Config{
		APIID:    apiID,
		APIHash:  os.Getenv("API_HASH"),
		Session:  parsed,
		Log:      log,
		Observer: shadow.NewObserver(log),
	})
	if err != nil {
		return err
	}

	log.Info("shadow 模式启动",
		"dc", parsed.DCID, "addr", parsed.ServerAddr,
		"注意", "只观察不处理;不碰 telegram_client 锁;不写回 session")

	err = client.Run(ctx)
	if err != nil && ctx.Err() == nil {
		return err
	}

	summary, _ := client.Observer().MarshalSummary()
	log.Info("shadow 观察摘要", "summary", string(summary))
	return nil
}

// runBoth 同时跑边缘节点和影子客户端 —— 影子验证期用。
func runBoth(log *slog.Logger) error {
	ctx, stop := signalCtx()
	defer stop()

	errCh := make(chan error, 2)

	go func() {
		if err := serveEdge(ctx, log); err != nil {
			errCh <- err
		}
	}()

	go func() {
		if err := runShadowCtx(ctx, log); err != nil {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		return nil
	}
}

// runShadowCtx 是 runShadow 的 context 版本,供 runBoth 复用。
func runShadowCtx(ctx context.Context, log *slog.Logger) error {
	sessionStr := os.Getenv("SETTING_TG_SESSION")
	if sessionStr == "" {
		return errors.New("SETTING_TG_SESSION 未配置")
	}
	parsed, err := tgsession.Parse(sessionStr)
	if err != nil {
		return err
	}
	apiID, err := strconv.Atoi(os.Getenv("API_ID"))
	if err != nil || apiID == 0 {
		return errors.New("API_ID 未配置或不是合法数字")
	}
	client, err := shadow.New(shadow.Config{
		APIID: apiID, APIHash: os.Getenv("API_HASH"),
		Session: parsed, Log: log, Observer: shadow.NewObserver(log),
	})
	if err != nil {
		return err
	}
	log.Info("shadow 模式启动(与 edge 并行)", "dc", parsed.DCID, "mode", "read-only")

	if err := client.Run(ctx); err != nil && ctx.Err() == nil {
		return err
	}
	return nil
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}