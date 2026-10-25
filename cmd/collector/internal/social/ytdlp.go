package social

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	progressRegex = regexp.MustCompile(`\[download\]\s+(\d+(?:\.\d+)?)%`)
)

type ytDlpFormat struct {
	FormatID   string  `json:"format_id"`
	URL        string  `json:"url"`
	Ext        string  `json:"ext"`
	VCodec     string  `json:"vcodec"`
	ACodec     string  `json:"acodec"`
	TBR        float64 `json:"tbr"`
	Filesize   int64   `json:"filesize"`
	Height     int     `json:"height"`
	Width      int     `json:"width"`
	FormatNote string  `json:"format_note"`
}

type ytDlpDump struct {
	ID        string        `json:"id"`
	Title     string        `json:"title"`
	Uploader  string        `json:"uploader"`
	Extractor string        `json:"extractor"`
	URL       string        `json:"url"`
	Ext       string        `json:"ext"`
	Formats   []ytDlpFormat `json:"formats"`
}

// IsYtDlpAvailable returns true if yt-dlp binary is installed in system PATH.
func IsYtDlpAvailable() bool {
	_, err := exec.LookPath("yt-dlp")
	return err == nil
}

// ExtractWithYtDlp extracts media metadata using yt-dlp -J.
func ExtractWithYtDlp(ctx context.Context, rawURL string) (*ParseResult, error) {
	if !IsYtDlpAvailable() {
		return nil, fmt.Errorf("social: yt-dlp is not installed")
	}

	execCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(execCtx, "yt-dlp",
		"-J",
		"--no-playlist",
		"--no-warnings",
		"--socket-timeout", "15",
		rawURL,
	)

	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("social: yt-dlp extraction failed: %w", err)
	}

	var dump ytDlpDump
	if err := json.Unmarshal(out, &dump); err != nil {
		return nil, fmt.Errorf("social: failed to parse yt-dlp output: %w", err)
	}

	platform := strings.ToLower(dump.Extractor)
	if platform == "" {
		platform = "social"
	}
	author := dump.Uploader
	if author == "" {
		author = strings.ToUpper(platform)
	}
	title := strings.TrimSpace(dump.Title)
	if title == "" {
		title = dump.ID
	}

	ext := dump.Ext
	if ext == "" {
		ext = "mp4"
	}

	// Look for direct video URL with both audio and video
	var bestURL string
	var bestTBR float64
	var bestHeight int
	var bestSize int64

	for _, f := range dump.Formats {
		// Prefer mp4 with both video and audio
		if f.VCodec != "none" && f.ACodec != "none" && f.URL != "" {
			if f.TBR > bestTBR || f.Height > bestHeight {
				bestURL = f.URL
				bestTBR = f.TBR
				bestHeight = f.Height
				bestSize = f.Filesize
			}
		}
	}

	useYtDlp := false
	quality := "highest"
	if bestHeight > 0 {
		quality = fmt.Sprintf("%dp", bestHeight)
	}

	if bestURL == "" {
		// If no direct muxed stream found, tell downloader to invoke yt-dlp binary directly
		useYtDlp = true
		bestURL = rawURL
	}

	rawName := fmt.Sprintf("[%s] %s - %s_%s.%s", strings.ToUpper(platform), author, truncateString(title, 40), dump.ID, ext)
	mediaItem := MediaItem{
		Type:     "video",
		URL:      bestURL,
		FileName: SanitizeFileName(rawName),
		FileSize: bestSize,
		Quality:  quality,
		Platform: platform,
		WebURL:   rawURL,
		UseYtDlp: useYtDlp,
	}

	return &ParseResult{
		Platform:    platform,
		OriginalURL: rawURL,
		Title:       title,
		Author:      author,
		Media:       []MediaItem{mediaItem},
	}, nil
}

// DownloadWithYtDlp invokes yt-dlp binary to download media directly to destPath.
func DownloadWithYtDlp(ctx context.Context, webURL string, destPath string, progress func(ratio float64)) error {
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return fmt.Errorf("social: failed to create dest dir: %w", err)
	}

	tmpFile := destPath + ".tmp"
	defer os.Remove(tmpFile)

	args := []string{
		"--newline",
		"--no-playlist",
		"--no-warnings",
		"-f", "bestvideo+bestaudio/best",
		"--merge-output-format", "mp4",
		"-o", tmpFile,
		webURL,
	}

	cmd := exec.CommandContext(ctx, "yt-dlp", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("social: yt-dlp stdout pipe error: %w", err)
	}
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("social: failed to start yt-dlp: %w", err)
	}

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		line := scanner.Text()
		if m := progressRegex.FindStringSubmatch(line); len(m) > 1 {
			if pct, err := strconv.ParseFloat(m[1], 64); err == nil && progress != nil {
				progress(pct / 100.0)
			}
		}
	}

	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("social: yt-dlp download failed: %w", err)
	}

	// yt-dlp may append extension if merged, check if tmpFile or tmpFile with ext exists
	finalTmp := tmpFile
	if _, err := os.Stat(finalTmp); err != nil {
		// check if .mp4 was added
		if _, err := os.Stat(tmpFile + ".mp4"); err == nil {
			finalTmp = tmpFile + ".mp4"
		}
	}

	if err := os.Rename(finalTmp, destPath); err != nil {
		return fmt.Errorf("social: rename downloaded file to dest failed: %w", err)
	}

	return nil
}
