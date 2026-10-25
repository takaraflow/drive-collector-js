package social

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	tweetIDRegex       = regexp.MustCompile(`(?i)(?:twitter|x|fxtwitter|vxtwitter|fixupx)\.com/(?:#!/)?(?:[\w.-]+/)?status(?:es)?/(\d+)`)
	fxTwitterBaseURL   = "https://api.fxtwitter.com"
	syndicationBaseURL = "https://cdn.syndication.twimg.com"
)

type fxTwitterResponse struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Tweet   struct {
		ID     string `json:"id"`
		Text   string `json:"text"`
		Author struct {
			Name       string `json:"name"`
			ScreenName string `json:"screen_name"`
		} `json:"author"`
		Media struct {
			Videos []struct {
				Type     string `json:"type"`
				URL      string `json:"url"`
				Variants []struct {
					Bitrate     int64  `json:"bitrate"`
					ContentType string `json:"content_type"`
					URL         string `json:"url"`
				} `json:"variants"`
			} `json:"videos"`
			Photos []struct {
				Type string `json:"type"`
				URL  string `json:"url"`
			} `json:"photos"`
		} `json:"media"`
	} `json:"tweet"`
}

type syndicationResponse struct {
	Text string `json:"text"`
	User struct {
		Name       string `json:"name"`
		ScreenName string `json:"screen_name"`
	} `json:"user"`
	Video struct {
		Variants []struct {
			Bitrate     int64  `json:"bitrate"`
			ContentType string `json:"content_type"`
			Type        string `json:"type"`
			Src         string `json:"src"`
			URL         string `json:"url"`
		} `json:"variants"`
	} `json:"video"`
	Photos []struct {
		URL string `json:"url"`
	} `json:"photos"`
}

// ParseTwitter extracts media from Twitter/X links with highest resolution selection.
func ParseTwitter(ctx context.Context, rawURL string) (*ParseResult, error) {
	m := tweetIDRegex.FindStringSubmatch(rawURL)
	if len(m) < 2 {
		return nil, fmt.Errorf("social: not a valid twitter/x status url: %s", rawURL)
	}
	tweetID := m[1]

	client := &http.Client{Timeout: 12 * time.Second}

	// 1. Try FxTwitter API
	if res, err := fetchFxTwitter(ctx, client, tweetID, rawURL); err == nil && len(res.Media) > 0 {
		return res, nil
	}

	// 2. Fallback to Twitter Syndication API
	if res, err := fetchSyndication(ctx, client, tweetID, rawURL); err == nil && len(res.Media) > 0 {
		return res, nil
	}

	// 3. Fallback to yt-dlp
	return ExtractWithYtDlp(ctx, rawURL)
}

func fetchFxTwitter(ctx context.Context, client *http.Client, tweetID, rawURL string) (*ParseResult, error) {
	apiURL := fmt.Sprintf("%s/i/status/%s", fxTwitterBaseURL, tweetID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "DriveCollectorBot/4.0")
	req.Header.Set("Accept", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fxtwitter returned status: %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var fx fxTwitterResponse
	if err := json.Unmarshal(body, &fx); err != nil {
		return nil, err
	}
	if fx.Tweet.ID == "" {
		return nil, fmt.Errorf("fxtwitter: empty tweet data")
	}

	author := fx.Tweet.Author.Name
	if author == "" {
		author = fx.Tweet.Author.ScreenName
	}
	if author == "" {
		author = "Twitter"
	}

	title := strings.TrimSpace(fx.Tweet.Text)
	if title == "" {
		title = fmt.Sprintf("Tweet %s", tweetID)
	}

	var mediaItems []MediaItem

	// Process videos: pick highest bitrate mp4 variant
	for i, vid := range fx.Tweet.Media.Videos {
		type variant struct {
			bitrate int64
			url     string
		}
		var mp4s []variant
		for _, v := range vid.Variants {
			if strings.EqualFold(v.ContentType, "video/mp4") && v.URL != "" {
				mp4s = append(mp4s, variant{bitrate: v.Bitrate, url: v.URL})
			}
		}

		sort.Slice(mp4s, func(i, j int) bool {
			return mp4s[i].bitrate > mp4s[j].bitrate
		})

		bestURL := vid.URL
		quality := "highest"
		if len(mp4s) > 0 {
			bestURL = mp4s[0].url
			if mp4s[0].bitrate > 0 {
				quality = fmt.Sprintf("%dk", mp4s[0].bitrate/1000)
			}
		}

		if bestURL != "" {
			suffix := ""
			if len(fx.Tweet.Media.Videos) > 1 {
				suffix = fmt.Sprintf("_%d", i+1)
			}
			rawName := fmt.Sprintf("[X] %s - %s_%s%s.mp4", author, truncateString(title, 40), tweetID, suffix)
			mediaItems = append(mediaItems, MediaItem{
				Type:     "video",
				URL:      bestURL,
				Quality:  quality,
				FileName: SanitizeFileName(rawName),
				Platform: "twitter",
				WebURL:   rawURL,
			})
		}
	}

	// Process photos: request original size via name=orig
	for i, p := range fx.Tweet.Media.Photos {
		photoURL := p.URL
		if strings.Contains(photoURL, "twimg.com") {
			if strings.Contains(photoURL, "?") {
				re := regexp.MustCompile(`name=[^&]+`)
				photoURL = re.ReplaceAllString(photoURL, "name=orig")
			} else {
				photoURL = photoURL + "?name=orig"
			}
		}

		suffix := ""
		if len(fx.Tweet.Media.Photos) > 1 {
			suffix = fmt.Sprintf("_%d", i+1)
		}
		rawName := fmt.Sprintf("[X] %s - %s%s.jpg", author, tweetID, suffix)
		mediaItems = append(mediaItems, MediaItem{
			Type:     "photo",
			URL:      photoURL,
			Quality:  "original",
			FileName: SanitizeFileName(rawName),
			Platform: "twitter",
			WebURL:   rawURL,
		})
	}

	return &ParseResult{
		Platform:    "twitter",
		OriginalURL: rawURL,
		Title:       title,
		Author:      author,
		Media:       mediaItems,
	}, nil
}

func fetchSyndication(ctx context.Context, client *http.Client, tweetID, rawURL string) (*ParseResult, error) {
	apiURL := fmt.Sprintf("%s/tweet-result?id=%s&token=1", syndicationBaseURL, tweetID)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("syndication returned status: %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var syn syndicationResponse
	if err := json.Unmarshal(body, &syn); err != nil {
		return nil, err
	}

	author := syn.User.Name
	if author == "" {
		author = syn.User.ScreenName
	}
	if author == "" {
		author = "Twitter"
	}

	title := strings.TrimSpace(syn.Text)
	if title == "" {
		title = fmt.Sprintf("Tweet %s", tweetID)
	}

	var mediaItems []MediaItem

	if len(syn.Video.Variants) > 0 {
		type variant struct {
			bitrate int64
			url     string
		}
		var mp4s []variant
		for _, v := range syn.Video.Variants {
			isMP4 := strings.EqualFold(v.ContentType, "video/mp4") || strings.EqualFold(v.Type, "video/mp4")
			target := v.Src
			if target == "" {
				target = v.URL
			}
			if isMP4 && target != "" {
				mp4s = append(mp4s, variant{bitrate: v.Bitrate, url: target})
			}
		}

		sort.Slice(mp4s, func(i, j int) bool {
			return mp4s[i].bitrate > mp4s[j].bitrate
		})

		if len(mp4s) > 0 {
			best := mp4s[0]
			quality := "highest"
			if best.bitrate > 0 {
				quality = fmt.Sprintf("%dk", best.bitrate/1000)
			}
			rawName := fmt.Sprintf("[X] %s - %s_%s.mp4", author, truncateString(title, 40), tweetID)
			mediaItems = append(mediaItems, MediaItem{
				Type:     "video",
				URL:      best.url,
				Quality:  quality,
				FileName: SanitizeFileName(rawName),
				Platform: "twitter",
				WebURL:   rawURL,
			})
		}
	}

	for i, p := range syn.Photos {
		photoURL := p.URL
		if strings.Contains(photoURL, "twimg.com") {
			if strings.Contains(photoURL, "?") {
				re := regexp.MustCompile(`name=[^&]+`)
				photoURL = re.ReplaceAllString(photoURL, "name=orig")
			} else {
				photoURL = photoURL + "?name=orig"
			}
		}
		suffix := ""
		if len(syn.Photos) > 1 {
			suffix = fmt.Sprintf("_%d", i+1)
		}
		rawName := fmt.Sprintf("[X] %s - %s%s.jpg", author, tweetID, suffix)
		mediaItems = append(mediaItems, MediaItem{
			Type:     "photo",
			URL:      photoURL,
			Quality:  "original",
			FileName: SanitizeFileName(rawName),
			Platform: "twitter",
			WebURL:   rawURL,
		})
	}

	return &ParseResult{
		Platform:    "twitter",
		OriginalURL: rawURL,
		Title:       title,
		Author:      author,
		Media:       mediaItems,
	}, nil
}

func truncateString(s string, maxRunes int) string {
	runes := []rune(s)
	if len(runes) <= maxRunes {
		return s
	}
	return string(runes[:maxRunes])
}
