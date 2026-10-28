package logger

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"
)

// DatadogConfig 为 Datadog 日志传输配置。
type DatadogConfig struct {
	APIKey     string
	Site       string // 如 datadoghq.com, datadoghq.eu
	Service    string
	Hostname   string
	HTTPClient *http.Client
}

// DatadogLogEntry 单条 Datadog 日志。
type DatadogLogEntry struct {
	DDSource   string         `json:"ddsource"`
	DDTags     string         `json:"ddtags,omitempty"`
	Hostname   string         `json:"hostname,omitempty"`
	Message    string         `json:"message"`
	Service    string         `json:"service"`
	Status     string         `json:"status"` // info, warning, error, debug
	Timestamp  int64          `json:"timestamp"`
	Attributes map[string]any `json:"attributes,omitempty"`
}

// DatadogShipper 将日志批量发送到 Datadog HTTP Logs API。
type DatadogShipper struct {
	cfg        DatadogConfig
	url        string
	client     *http.Client
	mu         sync.Mutex
	buffer     []DatadogLogEntry
	maxBatch   int
	flushTimer *time.Timer
}

// NewDatadogShipper 创建 Datadog 日志投递器。
func NewDatadogShipper(cfg DatadogConfig) *DatadogShipper {
	site := cfg.Site
	if site == "" {
		site = os.Getenv("DATADOG_SITE")
		if site == "" {
			site = "datadoghq.com"
		}
	}
	apiKey := cfg.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("DATADOG_API_KEY")
	}
	service := cfg.Service
	if service == "" {
		service = "drive-collector"
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}

	url := fmt.Sprintf("https://http-intake.logs.%s/v1/input/%s", site, apiKey)
	return &DatadogShipper{
		cfg: DatadogConfig{
			APIKey:   apiKey,
			Site:     site,
			Service:  service,
			Hostname: cfg.Hostname,
		},
		url:      url,
		client:   client,
		maxBatch: 100,
	}
}

// SendDirect 发送一批日志到 Datadog。
func (s *DatadogShipper) SendDirect(ctx context.Context, entries []DatadogLogEntry) error {
	if s.cfg.APIKey == "" || len(entries) == 0 {
		return nil
	}

	body, err := json.Marshal(entries)
	if err != nil {
		return fmt.Errorf("datadog: marshal error: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("datadog: build request error: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("datadog: send logs error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("datadog: API returned status %d", resp.StatusCode)
	}
	return nil
}
