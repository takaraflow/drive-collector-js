// Command collector 是 Go 边缘节点。
//
// 当前形态:接管 QStash 任务 webhook 的接收与转发(/api/v2/tasks/*),
// 其余路由仍由 Node 处理。两者并行运行,由 LB 按路径分流。
//
// 环境变量与 JS 侧读同一套,这样无缝替换时不需要改任何部署配置:
//
//	PORT                        监听端口(默认 7860,与 Node 一致但不同进程)
//	QSTASH_CURRENT_SIGNING_KEY  当前签名密钥(必填)
//	QSTASH_NEXT_SIGNING_KEY     下一把签名密钥(轮换期用)
//	REDIS_URL / NF_REDIS_URL    查 telegram_client 锁用
//	D1_ACCOUNT_ID/D1_DATABASE_ID/D1_API_TOKEN  查活跃实例用
//	INSTANCE_ID                 本实例标识,写进 X-Forwarded-By-Instance
//	EDGE_SKIP_SIGNATURE_VERIFY   仅本地调试,生产必须 false
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
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	if err := run(log); err != nil {
		log.Error("edge node failed", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	currentKey := os.Getenv("QSTASH_CURRENT_SIGNING_KEY")
	if currentKey == "" {
		// 缺签名密钥等于完全不验签,必须硬失败而不是降级放行。
		return errors.New("QSTASH_CURRENT_SIGNING_KEY 未配置,拒绝以不验签模式启动")
	}

	skipVerify := os.Getenv("EDGE_SKIP_SIGNATURE_VERIFY") == "true"
	if skipVerify {
		log.Warn("EDGE_SKIP_SIGNATURE_VERIFY=true —— 验签已关闭,禁止用于生产")
	}

	port := 7860
	if p := os.Getenv("PORT"); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil {
			return errors.New("PORT 不是合法数字: " + p)
		}
		port = n
	}

	resolver := leader.NewResolverFromEnv()

	srv := edge.New(edge.Config{
		Port:       port,
		Log:        log,
		InstanceID: os.Getenv("INSTANCE_ID"),
		Receiver: &qstash.Receiver{
			CurrentSigningKey: currentKey,
			NextSigningKey:    os.Getenv("QSTASH_NEXT_SIGNING_KEY"),
		},
		Leader:     resolver,
		SkipVerify: skipVerify,
	})

	httpSrv := &http.Server{
		Addr:    ":" + strconv.Itoa(port),
		Handler: srv.Handler(),
		// 优雅关闭:收到 SIGTERM 后给在途请求 10s,和 Node 的
		// GracefulShutdown 时长对齐,避免 LB 切换时掐断请求。
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

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
			log.Error("优雅关闭超时", "err", err)
			return err
		}
		log.Info("已停止")
		return nil
	}
}