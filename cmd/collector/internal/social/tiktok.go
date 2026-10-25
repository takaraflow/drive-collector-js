package social

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

var tikWMBaseURL = "https://www.tikwm.com"

type tikWMResponse struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
	Data struct {
		ID     string `json:"id"`
		Title  string `json:"title"`
		Play   string `json:"play"`
		HDPlay string `json:"hdplay"`
		Size   int64  `json:"size"`
		HDSize int64  `json:"hd_size"`
		Author struct {
			Nickname string `json:"nickname"`
			UniqueID string `json:"unique_id"`
		} `json:"author"`
		Images []string `json:"images"`
	} `json:"data"`
}

// ParseTikTokOrDouyin extracts media from TikTok or Douyin links using TikWM API.
func ParseTikTokOrDouyin(ctx context.Context, rawURL string) (*ParseResult, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	platform := "tiktok"
	if strings.Contains(strings.ToLower(rawURL), "douyin.com") || strings.Contains(strings.ToLower(rawURL), "iesdouyin.com") {
		platform = "douyin"
	}

	apiURL := fmt.Sprintf("%s/api/?url=%s&hd=1", tikWMBaseURL, url.QueryEscape(rawURL))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err == nil {
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
		resp, err := client.Do(req)
		if err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				body, _ := io.ReadAll(resp.Body)
				var wm tikWMResponse
				if err := json.Unmarshal(body, &wm); err == nil && wm.Code == 0 {
					author := wm.Data.Author.Nickname
					if author == "" {
						author = wm.Data.Author.UniqueID
					}
					if author == "" {
						author = strings.ToUpper(platform)
					}
					title := strings.TrimSpace(wm.Data.Title)
					if title == "" {
						title = wm.Data.ID
					}

					var items []MediaItem
					videoURL := wm.Data.HDPlay
					fileSize := wm.Data.HDSize
					quality := "1080p (HD)"
					if videoURL == "" {
						videoURL = wm.Data.Play
						fileSize = wm.Data.Size
						quality = "720p"
					}

					if videoURL != "" {
					if strings.HasPrefix(videoURL, "/") {
						videoURL = tikWMBaseURL + videoURL
					}
						tag := "[TikTok]"
						if platform == "douyin" {
							tag = "[抖音]"
						}
						rawName := fmt.Sprintf("%s %s - %s_%s.mp4", tag, author, truncateString(title, 40), wm.Data.ID)
						items = append(items, MediaItem{
							Type:     "video",
							URL:      videoURL,
							FileName: SanitizeFileName(rawName),
							FileSize: fileSize,
							Quality:  quality,
							Platform: platform,
							WebURL:   rawURL,
						})
					}

					for idx, imgURL := range wm.Data.Images {
						if imgURL == "" {
							continue
						}
						tag := "[TikTok]"
						if platform == "douyin" {
							tag = "[抖音]"
						}
						rawName := fmt.Sprintf("%s %s - %s_%s_%d.jpg", tag, author, truncateString(title, 40), wm.Data.ID, idx+1)
						items = append(items, MediaItem{
							Type:     "photo",
							URL:      imgURL,
							FileName: SanitizeFileName(rawName),
							Platform: platform,
							WebURL:   rawURL,
						})
					}

					if len(items) > 0 {
						return &ParseResult{
							Platform:    platform,
							OriginalURL: rawURL,
							Title:       title,
							Author:      author,
							Media:       items,
						}, nil
					}
				}
			}
		}
	}

	// Fallback to yt-dlp
	return ExtractWithYtDlp(ctx, rawURL)
}
