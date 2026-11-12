package shortshare

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"
)

var (
	dateRegex   = regexp.MustCompile(`\b(?:\d{4})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b`)
	defaultUA   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
	adDomains   = []string{"google", "facebook", "analytics", "doubleclick", "ads", "tracking", "pixel", "meteor.today", "favicon", "logo"}
)

// Client 实现了针对 lurl.cc 与 myppt.cc 的提取器。
type Client struct {
	httpClient *http.Client
	userAgent  string
	nowFunc    func() time.Time
}

// ClientOption 配置选项。
type ClientOption func(*Client)

// WithHTTPClient 自定义 HTTP 客户端。
func WithHTTPClient(hc *http.Client) ClientOption {
	return func(c *Client) {
		if hc != nil {
			c.httpClient = hc
		}
	}
}

// WithNowFunc 自定义时间获取函数（用于单元测试固定日期）。
func WithNowFunc(nf func() time.Time) ClientOption {
	return func(c *Client) {
		if nf != nil {
			c.nowFunc = nf
		}
	}
}

// NewClient 创建短链资源提取客户端。
func NewClient(opts ...ClientOption) *Client {
	jar, _ := cookiejar.New(nil)
	c := &Client{
		httpClient: &http.Client{
			Jar:     jar,
			Timeout: 30 * time.Second,
		},
		userAgent: defaultUA,
		nowFunc:   time.Now,
	}
	for _, opt := range opts {
		opt(c)
	}
	return c
}

// Extract 提取指定短链的媒体资源。若 password 为空，则自动计算并尝试默认日期密码。
func (c *Client) Extract(ctx context.Context, rawURL string, password string) (*ExtractResult, error) {
	domain, codeID, err := ParseURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("invalid shortshare url: %w", err)
	}
	targetURL := fmt.Sprintf("https://%s/%s", domain, codeID)

	u, err := url.Parse(targetURL)
	if err != nil {
		return nil, fmt.Errorf("parse url error: %w", err)
	}

	// 1. 如果用户已提供密码，直接带密码请求验证
	if password != "" {
		return c.extractWithPassword(ctx, u, domain, codeID, password)
	}

	// 2. 无密码模式：先发起初始 GET 请求检查页面状态
	body, _, err := c.doGet(ctx, u.String(), nil)
	if err != nil {
		return nil, err
	}

	doc, err := html.Parse(strings.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("html parse error: %w", err)
	}

	if isAntiBot(doc, body) {
		return nil, ErrAntiBotBlocked
	}
	if isExpired(doc, body) {
		return nil, ErrNotFound
	}

	// 检查是否无需密码直接可见媒体
	mediaItems, title := extractMedia(doc, targetURL, codeID)
	if len(mediaItems) > 0 {
		return &ExtractResult{
			OriginalURL: targetURL,
			Domain:      domain,
			CodeID:      codeID,
			Title:       title,
			Items:       mediaItems,
		}, nil
	}

	// 页面需要密码：计算候选默认密码
	uploadDate := extractUploadDate(doc, body)
	var candidates []string
	if uploadDate != "" {
		candidates = append(candidates, uploadDate)
	}
	todayDate := c.getTodayCST()
	if todayDate != "" && todayDate != uploadDate {
		candidates = append(candidates, todayDate)
	}

	// 依次尝试候选日期密码
	for _, candidate := range candidates {
		res, err := c.extractWithPassword(ctx, u, domain, codeID, candidate)
		if err == nil && len(res.Items) > 0 {
			res.UploadDate = uploadDate
			res.PasswordUsed = candidate
			return res, nil
		}
	}

	return nil, ErrPasswordRequired
}

// extractWithPassword 携带指定密码尝试解密并提取资源。
func (c *Client) extractWithPassword(ctx context.Context, u *url.URL, domain, codeID, password string) (*ExtractResult, error) {
	targetURL := fmt.Sprintf("https://%s/%s", domain, codeID)

	// 1. 设置 Cookie: psc_<codeID>=<password>
	if c.httpClient.Jar != nil {
		cookie := &http.Cookie{
			Name:   fmt.Sprintf("psc_%s", codeID),
			Value:  password,
			Path:   "/",
			Domain: domain,
		}
		c.httpClient.Jar.SetCookies(u, []*http.Cookie{cookie})
	}

	// 2. 先做一次 GET 尝试 Cookie 解密
	body, _, err := c.doGet(ctx, targetURL, map[string]string{
		"Cookie": fmt.Sprintf("psc_%s=%s", codeID, password),
	})
	if err != nil {
		return nil, err
	}

	doc, err := html.Parse(strings.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("html parse error: %w", err)
	}

	if isAntiBot(doc, body) {
		return nil, ErrAntiBotBlocked
	}
	if isExpired(doc, body) {
		return nil, ErrNotFound
	}

	mediaItems, title := extractMedia(doc, targetURL, codeID)
	if len(mediaItems) > 0 {
		return &ExtractResult{
			OriginalURL:  targetURL,
			Domain:       domain,
			CodeID:       codeID,
			Title:        title,
			PasswordUsed: password,
			Items:        mediaItems,
		}, nil
	}

	// 3. 如果 Cookie 未直接解密，检查是否存在表单进行 POST 提交 (如 myppt.cc)
	formAction, formData := extractPasswordForm(doc, password)
	if len(formData) > 0 {
		postURL := targetURL
		if formAction != "" {
			if strings.HasPrefix(formAction, "http") {
				postURL = formAction
			} else if strings.HasPrefix(formAction, "/") {
				postURL = fmt.Sprintf("https://%s%s", domain, formAction)
			}
		}

		postBody, _, postErr := c.doPostForm(ctx, postURL, targetURL, formData)
		if postErr == nil {
			postDoc, err := html.Parse(strings.NewReader(postBody))
			if err == nil {
				if isExpired(postDoc, postBody) {
					return nil, ErrNotFound
				}
				postMedia, postTitle := extractMedia(postDoc, targetURL, codeID)
				if len(postMedia) > 0 {
					return &ExtractResult{
						OriginalURL:  targetURL,
						Domain:       domain,
						CodeID:       codeID,
						Title:        postTitle,
						PasswordUsed: password,
						Items:        postMedia,
					}, nil
				}
			}
		}
	}

	// 检查是否有明确的密码错误标识
	if isPasswordError(doc, body) {
		return nil, ErrPasswordWrong
	}

	// 既没有媒体，也没有明确成功，视为密码错误
	return nil, ErrPasswordWrong
}

func (c *Client) doGet(ctx context.Context, targetURL string, headers map[string]string) (string, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8")
	req.Header.Set("Accept-Language", "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7")
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return "", "", ErrNotFound
	}
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusServiceUnavailable {
		// 可能是 Cloudflare 403 / 503
		buf, _ := io.ReadAll(resp.Body)
		s := string(buf)
		if strings.Contains(s, "Cloudflare") || strings.Contains(s, "cf-ray") {
			return "", "", ErrAntiBotBlocked
		}
		return "", "", fmt.Errorf("http error: status %d", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("http error: status %d", resp.StatusCode)
	}

	buf, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", err
	}
	return string(buf), resp.Request.URL.String(), nil
}

func (c *Client) doPostForm(ctx context.Context, targetURL, referer string, formData url.Values) (string, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetURL, strings.NewReader(formData.Encode()))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Referer", referer)
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()

	buf, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", err
	}
	return string(buf), resp.Request.URL.String(), nil
}

func (c *Client) getTodayCST() string {
	cst := time.FixedZone("CST", 8*3600)
	now := c.nowFunc().In(cst)
	return now.Format("0102")
}

// extractUploadDate 从页面中寻找形如 2026-11-13 的日期并转换为 MMDD (1113)。
func extractUploadDate(n *html.Node, rawHTML string) string {
	var dateStr string
	var walker func(*html.Node)
	walker = func(node *html.Node) {
		if node == nil || dateStr != "" {
			return
		}
		if node.Type == html.ElementNode {
			class := getAttr(node, "class")
			if strings.Contains(class, "login_span") {
				text := getNodeText(node)
				if m := dateRegex.FindStringSubmatch(text); len(m) == 3 {
					dateStr = m[1] + m[2]
					return
				}
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walker(child)
		}
	}
	walker(n)

	if dateStr == "" {
		if m := dateRegex.FindStringSubmatch(rawHTML); len(m) == 3 {
			dateStr = m[1] + m[2]
		}
	}
	return dateStr
}

// extractPasswordForm 提取表单隐藏项并填入密码参数。
func extractPasswordForm(n *html.Node, password string) (string, url.Values) {
	var action string
	values := make(url.Values)
	var pwdFieldFound bool

	var walker func(*html.Node)
	walker = func(node *html.Node) {
		if node == nil {
			return
		}
		if node.Type == html.ElementNode {
			if node.Data == "form" {
				action = getAttr(node, "action")
			}
			if node.Data == "input" {
				inputType := strings.ToLower(getAttr(node, "type"))
				name := getAttr(node, "name")
				val := getAttr(node, "value")
				id := getAttr(node, "id")

				if inputType == "hidden" && name != "" {
					values.Set(name, val)
				}
				if inputType == "password" || strings.Contains(strings.ToLower(name), "pass") || id == "pasahaicsword" {
					if name == "" {
						name = "pasahaicsword"
					}
					values.Set(name, password)
					pwdFieldFound = true
				}
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walker(child)
		}
	}
	walker(n)

	if !pwdFieldFound {
		values.Set("pasahaicsword", password)
		values.Set("password", password)
	}

	return action, values
}

// extractMedia 从 DOM 中提取视频和图片媒体资源。
func extractMedia(n *html.Node, pageURL, codeID string) ([]MediaItem, string) {
	var items []MediaItem
	seenURLs := make(map[string]bool)
	var title string

	// 1. 查找标题
	var titleWalker func(*html.Node)
	titleWalker = func(node *html.Node) {
		if node == nil || title != "" {
			return
		}
		if node.Type == html.ElementNode && (node.Data == "h1" || node.Data == "title") {
			t := strings.TrimSpace(getNodeText(node))
			if t != "" && !strings.Contains(t, "404") && !strings.Contains(t, "Cloudflare") {
				title = t
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			titleWalker(child)
		}
	}
	titleWalker(n)

	// 2. 查找视频 (<video src="..."> 或 <video><source src="...">)
	var videoWalker func(*html.Node)
	videoWalker = func(node *html.Node) {
		if node == nil {
			return
		}
		if node.Type == html.ElementNode {
			if node.Data == "video" {
				if src := getAttr(node, "src"); src != "" {
					addMedia(&items, seenURLs, src, pageURL, codeID, "video/mp4", ".mp4")
				}
			}
			if node.Data == "source" {
				if src := getAttr(node, "src"); src != "" {
					mimeType := getAttr(node, "type")
					if mimeType == "" {
						mimeType = "video/mp4"
					}
					ext := ".mp4"
					if strings.Contains(src, ".webm") {
						ext = ".webm"
					}
					addMedia(&items, seenURLs, src, pageURL, codeID, mimeType, ext)
				}
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			videoWalker(child)
		}
	}
	videoWalker(n)

	// 3. 查找预加载图片 (<link rel="preload" as="image" href="...">)
	var linkWalker func(*html.Node)
	linkWalker = func(node *html.Node) {
		if node == nil {
			return
		}
		if node.Type == html.ElementNode && node.Data == "link" {
			rel := getAttr(node, "rel")
			as := getAttr(node, "as")
			href := getAttr(node, "href")
			if strings.EqualFold(rel, "preload") && strings.EqualFold(as, "image") && isContentImage(href) {
				addMedia(&items, seenURLs, href, pageURL, codeID, "image/jpeg", ".jpg")
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			linkWalker(child)
		}
	}
	linkWalker(n)

	// 4. 查找主内容图片 <img>
	var imgWalker func(*html.Node)
	imgWalker = func(node *html.Node) {
		if node == nil {
			return
		}
		if node.Type == html.ElementNode && node.Data == "img" {
			src := getAttr(node, "src")
			if src == "" {
				src = getAttr(node, "data-src")
			}
			if isContentImage(src) {
				addMedia(&items, seenURLs, src, pageURL, codeID, "image/jpeg", ".jpg")
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			imgWalker(child)
		}
	}
	imgWalker(n)

	return items, title
}

func addMedia(items *[]MediaItem, seen map[string]bool, rawMediaURL, pageURL, codeID, defaultMime, defaultExt string) {
	if rawMediaURL == "" {
		return
	}
	// 处理相对路径
	finalURL := resolveURL(pageURL, rawMediaURL)
	if finalURL == "" || seen[finalURL] {
		return
	}
	seen[finalURL] = true

	idx := len(*items) + 1
	fileName := extractFileName(finalURL, codeID, idx, defaultExt)

	*items = append(*items, MediaItem{
		URL:         finalURL,
		FileName:    fileName,
		ContentType: defaultMime,
		Headers: map[string]string{
			"Referer":    pageURL,
			"User-Agent": defaultUA,
		},
	})
}

func isContentImage(rawURL string) bool {
	if rawURL == "" {
		return false
	}
	lower := strings.ToLower(rawURL)
	for _, ad := range adDomains {
		if strings.Contains(lower, ad) {
			return false
		}
	}
	if strings.Contains(lower, "lurl") || strings.Contains(lower, "myppt") || strings.Contains(lower, "imgur") {
		return true
	}
	ext := filepath.Ext(strings.Split(lower, "?")[0])
	switch ext {
	case ".jpg", ".jpeg", ".png", ".gif", ".webp":
		return true
	}
	return false
}

func resolveURL(base, ref string) string {
	baseURL, err := url.Parse(base)
	if err != nil {
		return ref
	}
	refURL, err := url.Parse(ref)
	if err != nil {
		return ref
	}
	return baseURL.ResolveReference(refURL).String()
}

func extractFileName(mediaURL, codeID string, index int, defaultExt string) string {
	u, err := url.Parse(mediaURL)
	if err == nil && u.Path != "" {
		base := filepath.Base(u.Path)
		ext := filepath.Ext(base)
		if ext != "" && len(ext) <= 5 {
			if index > 1 {
				baseName := strings.TrimSuffix(base, ext)
				return fmt.Sprintf("%s_%d%s", baseName, index, ext)
			}
			return base
		}
	}
	if index > 1 {
		return fmt.Sprintf("%s_%d%s", codeID, index, defaultExt)
	}
	return fmt.Sprintf("%s%s", codeID, defaultExt)
}

func isExpired(n *html.Node, rawHTML string) bool {
	if strings.Contains(rawHTML, "該連結已過期") || strings.Contains(rawHTML, "该链接已过期") || strings.Contains(rawHTML, "連結不存在") || strings.Contains(rawHTML, "链接不存在") {
		return true
	}
	return false
}

func isAntiBot(n *html.Node, rawHTML string) bool {
	if strings.Contains(rawHTML, "cf-browser-verification") ||
		strings.Contains(rawHTML, "Checking your browser") ||
		strings.Contains(rawHTML, "Attention Required! | Cloudflare") {
		return true
	}
	return false
}

func isPasswordError(n *html.Node, rawHTML string) bool {
	return strings.Contains(rawHTML, "密碼錯誤") || strings.Contains(rawHTML, "密码错误") || strings.Contains(rawHTML, "密碼不正確")
}

func getAttr(n *html.Node, key string) string {
	for _, attr := range n.Attr {
		if strings.EqualFold(attr.Key, key) {
			return attr.Val
		}
	}
	return ""
}

func getNodeText(n *html.Node) string {
	var sb strings.Builder
	var walker func(*html.Node)
	walker = func(node *html.Node) {
		if node == nil {
			return
		}
		if node.Type == html.TextNode {
			sb.WriteString(node.Data)
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walker(child)
		}
	}
	walker(n)
	return sb.String()
}
