package social

import (
	"net/url"
	"regexp"
	"strings"
)

var (
	// Social media domains regexes
	douyinRegex    = regexp.MustCompile(`(?i)(?:https?://)?(?:[a-zA-Z0-9_-]+\.)?(?:douyin\.com|iesdouyin\.com)/[^\s<>"'` + "`" + `]+`)
	tiktokRegex    = regexp.MustCompile(`(?i)(?:https?://)?(?:[a-zA-Z0-9_-]+\.)?tiktok\.com/[^\s<>"'` + "`" + `]+`)
	twitterRegex   = regexp.MustCompile(`(?i)(?:https?://)?(?:[a-zA-Z0-9_-]+\.)?(?:twitter|x|fxtwitter|vxtwitter|fixupx)\.com/(?:#!/)?(?:[\w.-]+/)?status(?:es)?/\d+[^\s<>"'` + "`" + `]*`)
	instagramRegex = regexp.MustCompile(`(?i)(?:https?://)?(?:[a-zA-Z0-9_-]+\.)?(?:instagram\.com|instagr\.am)/(?:p|reel|reels|tv)/[\w-]+[^\s<>"'` + "`" + `]*`)
	threadsRegex   = regexp.MustCompile(`(?i)(?:https?://)?(?:[a-zA-Z0-9_-]+\.)?threads\.(?:net|com)/(?:@[\w.-]+/post|t)/[\w-]+[^\s<>"'` + "`" + `]*`)

	allPatterns = []*regexp.Regexp{
		douyinRegex,
		tiktokRegex,
		twitterRegex,
		instagramRegex,
		threadsRegex,
	}

	invalidCharsRegex = regexp.MustCompile(`[<>:"/\\|?*]+`)
	whitespaceRegex   = regexp.MustCompile(`\s+`)
)

// IsSocialMediaURL returns true if the URL matches any supported social media pattern.
func IsSocialMediaURL(rawURL string) bool {
	if rawURL == "" {
		return false
	}
	for _, p := range allPatterns {
		if p.MatchString(rawURL) {
			return true
		}
	}
	return false
}

// ExtractSocialMediaURLs finds all social media links in the provided text.
func ExtractSocialMediaURLs(text string) []string {
	if text == "" {
		return nil
	}

	type matchItem struct {
		index int
		url   string
	}
	var matches []matchItem

	for _, p := range allPatterns {
		locs := p.FindAllStringIndex(text, -1)
		for _, loc := range locs {
			raw := text[loc[0]:loc[1]]
			cleaned := strings.TrimRight(raw, "),.;]}!！?？，。、；")
			if !strings.HasPrefix(strings.ToLower(cleaned), "http://") && !strings.HasPrefix(strings.ToLower(cleaned), "https://") {
				cleaned = "https://" + cleaned
			}
			if u, err := url.Parse(cleaned); err == nil && u.Host != "" {
				matches = append(matches, matchItem{index: loc[0], url: u.String()})
			}
		}
	}

	if len(matches) == 0 {
		return nil
	}

	// Sort by index to maintain appearance order
	for i := 0; i < len(matches); i++ {
		for j := i + 1; j < len(matches); j++ {
			if matches[i].index > matches[j].index {
				matches[i], matches[j] = matches[j], matches[i]
			}
		}
	}

	seen := make(map[string]bool)
	var result []string
	for _, m := range matches {
		if !seen[m.url] {
			seen[m.url] = true
			result = append(result, m.url)
		}
	}
	return result
}

// SanitizeFileName cleans a string to be a safe filesystem and drive name.
func SanitizeFileName(name string) string {
	name = strings.TrimSpace(name)
	name = invalidCharsRegex.ReplaceAllString(name, "_")
	name = whitespaceRegex.ReplaceAllString(name, " ")
	name = strings.Trim(name, ". ")
	if name == "" {
		return "unnamed_media"
	}
	if len(name) > 180 {
		name = name[:180]
	}
	return strings.TrimSpace(name)
}
