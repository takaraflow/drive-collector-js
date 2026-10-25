package social

import (
	"context"
	"fmt"
	"strings"
)

// Parse inspects a social media URL, runs the appropriate extractor, and returns the media items.
func Parse(ctx context.Context, rawURL string) (*ParseResult, error) {
	if rawURL == "" {
		return nil, fmt.Errorf("social: empty url")
	}

	lower := strings.ToLower(rawURL)

	// 1. Twitter / X
	if strings.Contains(lower, "twitter.com") || strings.Contains(lower, "x.com") ||
		strings.Contains(lower, "fxtwitter.com") || strings.Contains(lower, "vxtwitter.com") ||
		strings.Contains(lower, "fixupx.com") {
		return ParseTwitter(ctx, rawURL)
	}

	// 2. TikTok / Douyin
	if strings.Contains(lower, "tiktok.com") || strings.Contains(lower, "douyin.com") || strings.Contains(lower, "iesdouyin.com") {
		return ParseTikTokOrDouyin(ctx, rawURL)
	}

	// 3. Instagram / Threads / Others -> yt-dlp
	return ExtractWithYtDlp(ctx, rawURL)
}
