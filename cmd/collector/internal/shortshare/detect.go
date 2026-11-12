package shortshare

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	shortshareURLPattern = regexp.MustCompile(`(?i)\bhttps?://(?:www\.)?(lurl\.cc|myppt\.cc)/([a-zA-Z0-9_-]+)\b`)
)

// ExtractShortshareURLs 从文本中提取所有符合规范的 lurl.cc 与 myppt.cc 短链。
func ExtractShortshareURLs(text string) []string {
	if text == "" {
		return nil
	}
	matches := shortshareURLPattern.FindAllString(text, -1)
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

// IsShortshareURL 判断给定 URL 是否为 lurl.cc 或 myppt.cc 短链。
func IsShortshareURL(rawURL string) bool {
	return shortshareURLPattern.MatchString(rawURL)
}

// ParseURL 解析短链的域名和资源代码 ID。
func ParseURL(rawURL string) (domain string, codeID string, err error) {
	m := shortshareURLPattern.FindStringSubmatch(rawURL)
	if len(m) < 3 {
		return "", "", fmt.Errorf("invalid shortshare url: %s", rawURL)
	}
	domain = strings.ToLower(m[1])
	codeID = m[2]
	return domain, codeID, nil
}

// NormalizeURL 标准化短链 URL。
func NormalizeURL(rawURL string) string {
	domain, codeID, err := ParseURL(rawURL)
	if err != nil {
		return rawURL
	}
	return fmt.Sprintf("https://%s/%s", domain, codeID)
}

// ExtractContentID 提取资源 ID。
func ExtractContentID(rawURL string) string {
	_, codeID, err := ParseURL(rawURL)
	if err != nil {
		return ""
	}
	return codeID
}
