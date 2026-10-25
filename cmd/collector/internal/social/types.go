package social

// MediaItem represents a parsed media file ready for download.
type MediaItem struct {
	Type     string            `json:"type"`                // "video", "photo", "audio"
	URL      string            `json:"url"`                 // Direct media download URL
	FileName string            `json:"file_name"`           // Output file name
	FileSize int64             `json:"file_size,omitempty"` // Estimated or exact size in bytes
	Quality  string            `json:"quality,omitempty"`   // Resolution or quality label (e.g. "1080p", "720p", "HD")
	Platform string            `json:"platform"`            // "twitter", "tiktok", "douyin", "instagram", "threads"
	WebURL   string            `json:"web_url"`             // Original post/tweet URL
	UseYtDlp bool              `json:"use_yt_dlp,omitempty"`// Force download via yt-dlp binary
	Headers  map[string]string `json:"headers,omitempty"`   // Required HTTP request headers
}

// ParseResult represents the metadata and media list extracted from a social media post.
type ParseResult struct {
	Platform    string      `json:"platform"`
	OriginalURL string      `json:"original_url"`
	Title       string      `json:"title,omitempty"`
	Author      string      `json:"author,omitempty"`
	Media       []MediaItem `json:"media"`
}
