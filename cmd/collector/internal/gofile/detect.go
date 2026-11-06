package gofile

import (
	"regexp"
	"strings"
)

var (
	gofileURLPattern = regexp.MustCompile(`(?i)\bhttps?://(?:www\.)?gofile\.io/d/([a-zA-Z0-9_-]+)\b`)
)

// ExtractGofileURLs 从文本中提取所有符合规范的 Gofile 链接。
func ExtractGofileURLs(text string) []string {
	if text == "" {
		return nil
	}
	matches := gofileURLPattern.FindAllString(text, -1)
	if len(matches) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(matches))
	var results []string
	for _, m := range matches {
		clean := strings.TrimRight(m, ".,!?;:)>]}'\"")
		if clean != "" && !seen[clean] {
			seen[clean] = true
			results = append(results, clean)
		}
	}
	return results
}

// IsGofileURL 判断给定 URL 是否为 Gofile 分享链接。
func IsGofileURL(rawURL string) bool {
	return gofileURLPattern.MatchString(rawURL)
}

// ExtractContentID 从 Gofile URL 中提取内容 ID（如 bjpcBx9H）。
func ExtractContentID(rawURL string) string {
	m := gofileURLPattern.FindStringSubmatch(rawURL)
	if len(m) > 1 {
		return m[1]
	}
	return ""
}
