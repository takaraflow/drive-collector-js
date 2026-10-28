package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/auth"
	"github.com/youngsx/drive-collector/cmd/collector/internal/social"
	"github.com/youngsx/drive-collector/cmd/collector/internal/store"
	tgclient "github.com/youngsx/drive-collector/cmd/collector/internal/telegram"
)

var (
	httpURLRegex         = regexp.MustCompile(`(?i)https?://[^\s<>"'` + "`" + `]+`)
	unsupportedSchemeReg = regexp.MustCompile(`(?i)\b(?:magnet|ed2k|ipfs|ipns|ftp|sftp|smb|file|data|javascript):[^\s<>"'` + "`" + `]*`)
	telegramHosts        = map[string]bool{
		"t.me":            true,
		"telegram.me":     true,
		"www.t.me":        true,
		"www.telegram.me": true,
	}
)

type externalSourceInfo struct {
	URL         string `json:"url"`
	FinalURL    string `json:"final_url"`
	DisplayURL  string `json:"display_url"`
	FileName    string `json:"file_name"`
	FileSize    int64  `json:"file_size"`
	ContentType string `json:"content_type"`
}

func stripTrailingPunctuation(s string) string {
	return strings.TrimRight(s, "),.;]}")
}

func isTorrentURL(u *url.URL) bool {
	return strings.HasSuffix(strings.ToLower(u.Path), ".torrent")
}

func extractExternalHTTPURLs(text string) []string {
	matches := httpURLRegex.FindAllString(text, -1)
	var urls []string
	seen := make(map[string]bool)
	for _, m := range matches {
		cleaned := stripTrailingPunctuation(m)
		u, err := url.Parse(cleaned)
		if err != nil || u.Scheme == "" || u.Host == "" {
			continue
		}
		host := strings.ToLower(u.Hostname())
		if telegramHosts[host] {
			continue
		}
		// 社媒链接由 social media parser 专门处理
		if len(social.ExtractSocialMediaURLs(cleaned)) > 0 {
			continue
		}
		if isTorrentURL(u) {
			continue
		}
		stdURL := u.String()
		if !seen[stdURL] {
			seen[stdURL] = true
			urls = append(urls, stdURL)
		}
	}
	return urls
}

func findUnsupportedExternalLinks(text string) []string {
	var unsupported []string
	seen := make(map[string]bool)
	matches := unsupportedSchemeReg.FindAllString(text, -1)
	for _, m := range matches {
		cleaned := stripTrailingPunctuation(m)
		if !seen[cleaned] {
			seen[cleaned] = true
			unsupported = append(unsupported, cleaned)
		}
	}
	httpMatches := httpURLRegex.FindAllString(text, -1)
	for _, m := range httpMatches {
		cleaned := stripTrailingPunctuation(m)
		u, err := url.Parse(cleaned)
		if err == nil && isTorrentURL(u) {
			if !seen[cleaned] {
				seen[cleaned] = true
				unsupported = append(unsupported, cleaned)
			}
		}
	}
	return unsupported
}

func isBlockedIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsInterfaceLocalMulticast() ||
		ip.IsMulticast() || ip.IsUnspecified() {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		if ip4.IsLoopback() || ip4.IsPrivate() || ip4.IsLinkLocalUnicast() ||
			ip4.IsLinkLocalMulticast() || ip4.IsMulticast() || ip4.IsUnspecified() {
			return true
		}
	}
	return false
}

func parseContentDispositionFileName(cd string) string {
	if cd == "" {
		return ""
	}
	_, params, err := mime.ParseMediaType(cd)
	if err == nil {
		if fn, ok := params["filename*"]; ok && fn != "" {
			if parts := strings.SplitN(fn, "''", 2); len(parts) == 2 {
				if unescaped, err := url.QueryUnescape(parts[1]); err == nil {
					return unescaped
				}
			}
			return fn
		}
		if fn, ok := params["filename"]; ok && fn != "" {
			return fn
		}
	}
	if m := regexp.MustCompile(`(?i)filename\*=([^;]+)`).FindStringSubmatch(cd); len(m) > 1 {
		raw := strings.Trim(m[1], `"' `)
		if parts := strings.SplitN(raw, "''", 2); len(parts) == 2 {
			if unescaped, err := url.QueryUnescape(parts[1]); err == nil {
				return unescaped
			}
		}
		return raw
	}
	if m := regexp.MustCompile(`(?i)filename="([^"]+)"`).FindStringSubmatch(cd); len(m) > 1 {
		return m[1]
	}
	if m := regexp.MustCompile(`(?i)filename=([^;\s]+)`).FindStringSubmatch(cd); len(m) > 1 {
		return strings.Trim(m[1], `"' `)
	}
	return ""
}

func sanitizeExternalFileName(input string) string {
	decoded, err := url.PathUnescape(input)
	if err != nil {
		decoded = input
	}
	base := filepath.Base(decoded)
	base = strings.TrimSpace(base)

	cleaned := strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		if strings.ContainsRune(`<>:"/\|?*`, r) {
			return '_'
		}
		return r
	}, base)

	cleaned = strings.Trim(cleaned, ". ")
	if len(cleaned) > 180 {
		cleaned = cleaned[:180]
	}
	if cleaned == "" || cleaned == "." || cleaned == "/" {
		cleaned = "download.bin"
	}
	return cleaned
}

func redactURLForDisplay(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return rawURL
	}
	path := u.Path
	if len(path) > 80 {
		path = path[:77] + "..."
	}
	return fmt.Sprintf("%s://%s%s", u.Scheme, u.Host, path)
}

func formatBytes(b int64) string {
	if b <= 0 {
		return "未知大小"
	}
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	units := []string{"KB", "MB", "GB", "TB"}
	return fmt.Sprintf("%.2f %s", float64(b)/float64(div), units[exp])
}

func randomNonce(n int) string {
	b := make([]byte, n/2+1)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)[:n]
}

func probeExternalURL(ctx context.Context, targetURL string, maxBytes int64) (*externalSourceInfo, error) {
	u, err := url.Parse(targetURL)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported scheme %q", u.Scheme)
	}
	if u.User != nil {
		return nil, fmt.Errorf("credentials in URL not supported")
	}
	if u.Hostname() == "" {
		return nil, fmt.Errorf("missing hostname")
	}

	dialer := &net.Dialer{Timeout: 10 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
				return nil, fmt.Errorf("SSRF protection: localhost access denied")
			}
			ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
			if err != nil {
				return nil, fmt.Errorf("SSRF protection: DNS lookup failed: %w", err)
			}
			if len(ips) == 0 {
				return nil, fmt.Errorf("SSRF protection: no IP addresses found")
			}
			for _, ip := range ips {
				if isBlockedIP(ip) {
					return nil, fmt.Errorf("SSRF protection: prohibited IP address %s", ip)
				}
			}
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
		},
	}

	var finalURL string
	client := &http.Client{
		Transport: transport,
		Timeout:   15 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return fmt.Errorf("too many redirects")
			}
			host := req.URL.Hostname()
			if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
				return fmt.Errorf("SSRF protection: redirect to localhost denied")
			}
			ips, err := net.LookupIP(host)
			if err != nil {
				return fmt.Errorf("SSRF protection: redirect DNS lookup failed: %w", err)
			}
			for _, ip := range ips {
				if isBlockedIP(ip) {
					return fmt.Errorf("SSRF protection: redirect to prohibited IP %s denied", ip)
				}
			}
			return nil
		},
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodHead, targetURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "drive-collector/4 external-offline-download")
	req.Header.Set("Accept", "*/*")

	resp, err := client.Do(req)
	var needRangeGet bool
	if err == nil {
		finalURL = resp.Request.URL.String()
		if resp.StatusCode == http.StatusMethodNotAllowed || resp.StatusCode == http.StatusForbidden {
			needRangeGet = true
			resp.Body.Close()
		} else if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			resp.Body.Close()
			return nil, fmt.Errorf("HTTP error: %s", resp.Status)
		}
	} else {
		needRangeGet = true
	}

	if needRangeGet {
		req, err = http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", "drive-collector/4 external-offline-download")
		req.Header.Set("Accept", "*/*")
		req.Header.Set("Range", "bytes=0-0")
		resp, err = client.Do(req)
		if err != nil {
			return nil, fmt.Errorf("GET range probe failed: %w", err)
		}
		finalURL = resp.Request.URL.String()
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
			resp.Body.Close()
			return nil, fmt.Errorf("GET range probe returned status %s", resp.Status)
		}
	}
	defer resp.Body.Close()

	contentLength := resp.ContentLength
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		if parts := strings.Split(cr, "/"); len(parts) == 2 {
			if total, err := strconv.ParseInt(parts[1], 10, 64); err == nil && total > 0 {
				contentLength = total
			}
		}
	}

	if maxBytes > 0 && contentLength > maxBytes {
		return nil, fmt.Errorf("file size %d exceeds max allowed %d", contentLength, maxBytes)
	}

	fileName := parseContentDispositionFileName(resp.Header.Get("Content-Disposition"))
	if fileName == "" {
		if finalURL != "" {
			if fu, err := url.Parse(finalURL); err == nil && fu.Path != "" {
				fileName = filepath.Base(fu.Path)
			}
		}
		if fileName == "" || fileName == "/" || fileName == "." {
			fileName = filepath.Base(u.Path)
		}
	}
	fileName = sanitizeExternalFileName(fileName)
	contentType := resp.Header.Get("Content-Type")

	displayURL := redactURLForDisplay(finalURL)
	if displayURL == "" {
		displayURL = redactURLForDisplay(targetURL)
	}

	return &externalSourceInfo{
		URL:         targetURL,
		FinalURL:    finalURL,
		DisplayURL:  displayURL,
		FileName:    fileName,
		FileSize:    contentLength,
		ContentType: contentType,
	}, nil
}

// handleExternalURLMessage 识别并处理外部 HTTP/HTTPS 文件链接离线下载。
func (a *App) handleExternalURLMessage(ctx context.Context, msg messageInfo) bool {
	unsupported := findUnsupportedExternalLinks(msg.Text)
	urls := extractExternalHTTPURLs(msg.Text)
	if len(urls) == 0 && len(unsupported) == 0 {
		return false
	}

	userID := fmt.Sprintf("%d", msg.SenderID)
	if !a.can(ctx, userID, auth.ActionExternalLink) {
		_ = a.tg.SendMessage(ctx, msg.ChatID, "🔒 <b>外部链接离线下载暂未开放</b>\n\n当前仅管理员可创建外部链接任务。")
		return true
	}

	if len(urls) == 0 || len(unsupported) > 0 {
		_ = a.tg.SendMessage(ctx, msg.ChatID, "⚠️ <b>暂不支持这个链接</b>\n\n目前仅支持 HTTP/HTTPS 直链；P2P、种子、磁力和私有网络地址不会处理。")
		return true
	}

	if len(urls) > 1 {
		_ = a.tg.SendMessage(ctx, msg.ChatID, "⚠️ 一次只处理 1 个外部链接，请拆开发送。")
		return true
	}

	if !a.requireDrive(ctx, msg.ChatID, msg.SenderID) {
		return true
	}

	targetURL := urls[0]
	prober := a.probeURL
	if prober == nil {
		prober = probeExternalURL
	}

	source, err := prober(ctx, targetURL, 5*1024*1024*1024)
	if err != nil {
		a.log.Warn("外部链接探测失败", "url", targetURL, "err", err)
		_ = a.tg.SendMessage(ctx, msg.ChatID, "❌ <b>无法检查这个外部链接</b>\n\n请确认链接可公开访问，且不是内网、鉴权或重定向到受限地址。")
		return true
	}

	nonce := randomNonce(12)
	sessionData := map[string]string{
		"nonce":        nonce,
		"chat_id":      fmt.Sprintf("%d", msg.ChatID),
		"url":          source.URL,
		"final_url":    source.FinalURL,
		"display_url":  source.DisplayURL,
		"file_name":    source.FileName,
		"file_size":    strconv.FormatInt(source.FileSize, 10),
		"content_type": source.ContentType,
	}
	if a.bindSessions != nil {
		if err := a.bindSessions.Start(ctx, userID, "EXTERNAL_URL_CONFIRM", sessionData); err != nil {
			a.log.Error("保存外部链接确认会话失败", "err", err)
			_ = a.tg.SendMessage(ctx, msg.ChatID, "❌ 会话创建失败，请稍后重试。")
			return true
		}
	}

	confirmText := fmt.Sprintf("🌐 <b>确认离线下载外部链接？</b>\n\n📄 名称: <code>%s</code>\n📦 大小: <code>%s</code>\n🔗 来源: <code>%s</code>",
		escapeHTMLText(source.FileName),
		formatBytes(source.FileSize),
		escapeHTMLText(source.DisplayURL),
	)
	buttons := [][]tgclient.Button{
		{
			{Text: "❌ 取消", Data: "external_url_cancel_" + nonce},
			{Text: "✅ 确认下载", Data: "external_url_execute_" + nonce},
		},
	}
	_ = a.tg.SendWithButtons(ctx, msg.ChatID, confirmText, buttons)
	return true
}

// handleExternalURLCallback 处理外部链接确认或取消的按钮回调。
func (a *App) handleExternalURLCallback(ctx context.Context, cb tgclient.CallbackContext, data string) error {
	userID := fmt.Sprintf("%d", cb.UserID)
	answer := func(text string, alert bool) {
		if err := a.tg.AnswerCallback(ctx, cb.CallbackID, text, alert); err != nil {
			a.log.Warn("回应按钮失败", "err", err)
		}
	}

	if a.bindSessions == nil {
		answer("会话存储不可用", true)
		return nil
	}

	sess, err := a.bindSessions.Get(ctx, userID)
	if err != nil || sess == nil || sess.CurrentStep != "EXTERNAL_URL_CONFIRM" {
		answer("任务已不存在或已处理", true)
		return nil
	}

	isCancel := strings.HasPrefix(data, "external_url_cancel_")
	expectedNonce := strings.TrimPrefix(data, "external_url_cancel_")
	if !isCancel {
		expectedNonce = strings.TrimPrefix(data, "external_url_execute_")
	}

	if sess.Data["nonce"] != expectedNonce || sess.Data["chat_id"] != fmt.Sprintf("%d", cb.ChatID) {
		answer("任务已不存在或已处理", true)
		return nil
	}

	_ = a.bindSessions.Clear(ctx, userID)

	if isCancel {
		answer("已取消下载", false)
		_ = a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, "🚫 <b>下载已取消。</b>")
		return nil
	}

	// 确认下载：二次验证权限
	if !a.can(ctx, userID, auth.ActionExternalLink) {
		answer("无权执行此操作", true)
		return nil
	}

	fileName := sess.Data["file_name"]
	fileSize, _ := strconv.ParseInt(sess.Data["file_size"], 10, 64)
	sourceURL := sess.Data["url"]
	finalURL := sess.Data["final_url"]

	answer("已创建任务", false)
	_ = a.tg.EditMessage(ctx, cb.ChatID, cb.MsgID, fmt.Sprintf(
		"🌐 <b>已创建外部链接任务</b>\n\n📄 名称: <code>%s</code>\n正在排队处理...",
		escapeHTMLText(fileName),
	))

	taskID := newTaskID()
	noticeID := a.postNotice(ctx, cb.ChatID, taskID)

	refData, _ := json.Marshal(externalSourceRef{
		URL:      sourceURL,
		WebURL:   finalURL,
		UseYtDlp: false,
	})

	t := store.Task{
		ID:          taskID,
		UserID:      userID,
		ChatID:      nullableString(fmt.Sprintf("%d", cb.ChatID)),
		SourceType:  "external_url",
		FileName:    nullableString(fileName),
		FileSize:    fileSize,
		SourceRef:   nullableString(string(refData)),
		MsgID:       nullableInt(int64(noticeID)),
		SourceMsgID: nullableInt(int64(cb.MsgID)),
	}

	if err := a.repo.Create(ctx, t); err != nil {
		a.log.Error("创建外部链接任务失败", "taskId", taskID, "err", err)
		return nil
	}
	a.enqueue(ctx, taskID)
	a.log.Info("已创建外部链接任务", "taskId", taskID, "file", fileName, "size", fileSize)
	return nil
}
