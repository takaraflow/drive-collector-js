package app

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/social"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
)

type externalSourceRef struct {
	URL      string `json:"url"`
	WebURL   string `json:"web_url,omitempty"`
	UseYtDlp bool   `json:"use_yt_dlp,omitempty"`
	Quality  string `json:"quality,omitempty"`
	Platform string `json:"platform,omitempty"`
}

// handleSocialMediaMessage 检查并处理包含社媒链接的消息（X/Twitter、TikTok、抖音、IG、Threads 等）。
// 匹配并成功解析则返回 true；若解析失败且消息包含 WebPage 媒体卡片，返回 false 以回退到 Telegram 原生卡片下载。
func (a *App) handleSocialMediaMessage(ctx context.Context, msg messageInfo) bool {
	urls := social.ExtractSocialMediaURLs(msg.Text)
	if len(urls) == 0 {
		return false
	}

	if a.tg != nil && a.tg.SelfID() != 0 && msg.SenderID == a.tg.SelfID() {
		return false
	}

	if !a.requireDrive(ctx, msg.ChatID, msg.SenderID) {
		return true
	}

	a.log.Info("识别到社媒链接", "urls", urls, "chatId", msg.ChatID, "senderId", msg.SenderID)

	createdAny := false
	for _, rawURL := range urls {
		res, err := social.Parse(ctx, rawURL)
		if err != nil || res == nil || len(res.Media) == 0 {
			a.log.Warn("社媒最高画质解析未成功", "url", rawURL, "err", err)
			if msg.HasMedia {
				// 降级让后续流程处理 Telegram 网页预览媒体
				return false
			}
			errMsg := "未获取到可下载的媒体"
			if err != nil {
				errMsg = err.Error()
			}
			_ = a.notifier.SendMessage(ctx, msg.ChatID, fmt.Sprintf("❌ <b>社媒解析失败</b>\n\n链接: %s\n原因: %s", escapeHTMLText(rawURL), escapeHTMLText(errMsg)))
			continue
		}

		for _, item := range res.Media {
			taskID := newTaskID()
			noticeID := a.postNotice(ctx, msg.ChatID, taskID)

			refData, _ := json.Marshal(externalSourceRef{
				URL:      item.URL,
				WebURL:   item.WebURL,
				UseYtDlp: item.UseYtDlp,
				Quality:  item.Quality,
				Platform: item.Platform,
			})

			t := store.Task{
				ID:          taskID,
				UserID:      fmt.Sprintf("%d", msg.SenderID),
				ChatID:      nullableString(fmt.Sprintf("%d", msg.ChatID)),
				SourceType:  "external_url",
				FileName:    nullableString(item.FileName),
				FileSize:    item.FileSize,
				SourceRef:   nullableString(string(refData)),
				MsgID:       nullableInt(int64(noticeID)),
				SourceMsgID: nullableInt(int64(msg.ID)),
			}

			if err := a.repo.Create(ctx, t); err != nil {
				a.log.Error("创建社媒转存任务失败", "taskId", taskID, "err", err)
				continue
			}
			createdAny = true
			a.enqueue(ctx, taskID)
			a.log.Info("已创建社媒外链任务", "taskId", taskID, "platform", res.Platform, "file", item.FileName, "quality", item.Quality)
		}
	}

	if createdAny {
		return true
	}

	// 如果没有成功创建任务且消息有媒体卡片，允许回退
	return !msg.HasMedia
}

// downloadExternal 负责下载社媒或外部 URL 资源。
func (a *App) downloadExternal(ctx context.Context, t store.Task) error {
	var ref externalSourceRef
	if err := json.Unmarshal([]byte(t.SourceRef.String), &ref); err != nil {
		return fmt.Errorf("解析 external_url 引用失败: %w", err)
	}

	dest := filepath.Join(a.cfg.DownloadDir, sanitize(t.FileName.String))
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return fmt.Errorf("创建下载目录失败: %w", err)
	}

	progressFunc := func(ratio float64) {
		a.log.Debug("社媒外链下载中", "taskId", t.ID, "ratio", ratio)
	}

	if ref.UseYtDlp {
		targetURL := ref.WebURL
		if targetURL == "" {
			targetURL = ref.URL
		}
		if err := social.DownloadWithYtDlp(ctx, targetURL, dest, progressFunc); err != nil {
			_ = os.Remove(dest)
			return fmt.Errorf("yt-dlp 下载失败: %w", err)
		}
	} else {
		// 优先走 HTTP 直链流式下载
		err := a.downloadHTTP(ctx, ref.URL, dest, t.FileSize, progressFunc)
		if err != nil {
			a.log.Warn("直接 HTTP 下载失败，尝试 yt-dlp 回退", "url", ref.URL, "err", err)
			targetURL := ref.WebURL
			if targetURL == "" {
				targetURL = ref.URL
			}
			if ytErr := social.DownloadWithYtDlp(ctx, targetURL, dest, progressFunc); ytErr != nil {
				_ = os.Remove(dest)
				return fmt.Errorf("外链下载失败 (HTTP: %v, yt-dlp: %v)", err, ytErr)
			}
		}
	}

	info, err := os.Stat(dest)
	if err != nil {
		return fmt.Errorf("下载后取文件信息失败: %w", err)
	}
	if err := a.repo.UpdateFileMetadata(ctx, t.ID, filepath.Base(dest), info.Size()); err != nil {
		return err
	}
	return nil
}

type extProgressWriter struct {
	w        io.Writer
	total    int64
	written  int64
	progress func(ratio float64)
}

func (p *extProgressWriter) Write(b []byte) (int, error) {
	n, err := p.w.Write(b)
	p.written += int64(n)
	if p.progress != nil && p.total > 0 {
		p.progress(float64(p.written) / float64(p.total))
	}
	return n, err
}

func (a *App) downloadHTTP(ctx context.Context, fileURL, destPath string, totalSize int64, progress func(ratio float64)) error {
	tmp, err := os.CreateTemp(filepath.Dir(destPath), ".dl-ext-*")
	if err != nil {
		return fmt.Errorf("创建临时文件失败: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() {
		tmp.Close()
		_ = os.Remove(tmpPath)
	}()

	client := &http.Client{
		Timeout: 30 * time.Minute,
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fileURL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP 状态码异常: %d", resp.StatusCode)
	}

	if totalSize <= 0 && resp.ContentLength > 0 {
		totalSize = resp.ContentLength
	}

	pw := &extProgressWriter{
		w:        tmp,
		total:    totalSize,
		progress: progress,
	}

	if _, err := io.Copy(pw, resp.Body); err != nil {
		return fmt.Errorf("写盘失败: %w", err)
	}

	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭临时文件失败: %w", err)
	}

	if err := os.Rename(tmpPath, destPath); err != nil {
		return fmt.Errorf("重命名目标文件失败: %w", err)
	}
	return nil
}
