// Package shadowreport 周期性地产出影子比对结论。
//
// 这是整套影子验证的出口。没有它,Observer 只往日志里写,
// diff 永远算不出来 —— 「能不能切流量」就永远没有答案。
//
// 报告写两个地方:
//   - 人类可读的文本(日志)
//   - Redis key(shadow:diff),供外部脚本/CI 读取
//
// 刻意不在 HTTP 上开端点:影子容器通常没有对外端口,
// 而且那等于给一个只读组件开攻击面。
package shadowreport

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/youngsx/drive-collector/cmd/collector/internal/shadow"
)

// DiffKey 是结论写入的 Redis key。
const DiffKey = "shadow:diff"

// Reporter 周期产出 diff。
type Reporter struct {
	observer *shadow.Observer
	redis    *redis.Client
	log      *slog.Logger
	// Interval 是比对间隔。取 60s 与 Node 侧 flush 对齐 ——
	// 比 Node 慢会读到旧数据,比它快则反复比对同一批。
	Interval time.Duration
}

// New 构造 Reporter。redis 为 nil 时降级为只写日志。
func New(obs *shadow.Observer, rdb *redis.Client, log *slog.Logger) *Reporter {
	return &Reporter{
		observer: obs,
		redis:    rdb,
		log:      log,
		Interval: 60 * time.Second,
	}
}

// Run 周期比对直到 ctx 取消。
func (r *Reporter) Run(ctx context.Context) {
	ticker := time.NewTicker(r.Interval)
	defer ticker.Stop()

	// 启动时先出一份 —— 影子验证刚开始就能看到基线。
	r.reportOnce(ctx)

	for {
		select {
		case <-ctx.Done():
			// 停机前最后出一份,保留窗口边界上的证据。
			r.reportOnce(context.WithoutCancel(ctx))
			return
		case <-ticker.C:
			r.reportOnce(ctx)
		}
	}
}

// reportOnce 出一份结论。
func (r *Reporter) reportOnce(ctx context.Context) {
	if r.redis == nil {
		r.logFromObserverOnly()
		return
	}

	diff, err := r.observer.DiffAgainstNode(ctx, r.redis)
	if err != nil {
		r.log.Warn("影子比对失败(不影响运行)", "err", err)
		return
	}

	r.log.Info("影子比对结果",
		"match", diff.Match,
		"window", diff.Window,
		"rows", len(diff.Rows),
		"note", diff.Note)
	for _, row := range diff.Rows {
		if row.Delta != 0 {
			r.log.Info("  差异", "fingerprint", row.Fingerprint,
				"node", row.Node, "go", row.Go, "delta", row.Delta)
		}
	}

	// 落 Redis 让外部能读。不因为写失败而影响影子客户端。
	payload, err := json.Marshal(struct {
		At     time.Time      `json:"at"`
		Diff   shadow.Diff    `json:"diff"`
		GoSide shadow.Summary `json:"goSide"`
	}{At: time.Now().UTC(), Diff: diff, GoSide: r.observer.Summary()})
	if err != nil {
		return
	}
	if err := r.redis.Set(ctx, DiffKey, payload, shadow.WindowSeconds*time.Second).Err(); err != nil {
		r.log.Warn("影子结论写 Redis 失败", "err", err)
	}
}

// logFromObserverOnly 没配 Redis 时只打印本地观察 —— 仍然有用,
// 因为它至少告诉操作者「Go 侧看到没看到东西」。
func (r *Reporter) logFromObserverOnly() {
	s := r.observer.Summary()
	r.log.Info("影子观察(未连接 Redis,无法比对)",
		"total", s.Total,
		"windowed", s.WindowedTotal,
		"window", s.Window,
		"byType", s.ByType,
		"提示", "未配置 REDIS_URL/NF_REDIS_URL,无法与 Node 侧比对")
}

// FormatText 输出人类可读的结论,供日志或 CI 摘要使用。
func FormatText(d shadow.Diff) string {
	status := "不匹配"
	if d.Match {
		status = "一致"
	}
	out := fmt.Sprintf("影子比对:%s(窗口 %s)\n", status, d.Window)
	for _, row := range d.Rows {
		mark := " "
		if row.Delta != 0 {
			mark = "!"
		}
		out += fmt.Sprintf("%s node=%-5d go=%-5d delta=%-6d %s\n",
			mark, row.Node, row.Go, row.Delta, row.Fingerprint)
	}
	if d.Note != "" {
		out += "\n" + d.Note + "\n"
	}
	return out
}