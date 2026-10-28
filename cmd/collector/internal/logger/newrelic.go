package logger

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

// NewrelicConfig 为 New Relic 日志传输配置。
type NewrelicConfig struct {
	LicenseKey string
	Region     string // "US" 或 "EU"
	Service    string
	HTTPClient *http.Client
}

// NewrelicLogEntry 单条 New Relic 日志。
type NewrelicLogEntry struct {
	Timestamp  int64          `json:"timestamp,omitempty"`
	Message    string         `json:"message"`
	Level      string         `json:"level,omitempty"`
	Severity   string         `json:"severity,omitempty"`
	Attributes map[string]any `json:"attributes,omitempty"`
}

type newrelicPayloadCommon struct {
	Attributes map[string]any `json:"attributes"`
}

type newrelicPayloadBlock struct {
	Common newrelicPayloadCommon `json:"common"`
	Logs   []NewrelicLogEntry     `json:"logs"`
}

// NewrelicShipper 将日志批量发送到 New Relic Log API。
type NewrelicShipper struct {
	cfg    NewrelicConfig
	url    string
	client *http.Client
}

// NewNewrelicShipper 创建 New Relic 日志投递器。
func NewNewrelicShipper(cfg NewrelicConfig) *NewrelicShipper {
	key := cfg.LicenseKey
	if key == "" {
		key = os.Getenv("NEW_RELIC_LICENSE_KEY")
	}
	key = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(key, "'", ""), "\"", ""))

	region := cfg.Region
	if region == "" {
		region = os.Getenv("NEW_RELIC_REGION")
		if region == "" {
			region = "US"
		}
	}
	service := cfg.Service
	if service == "" {
		service = "drive-collector"
	}

	url := "https://log-api.newrelic.com/log/v1"
	if strings.EqualFold(region, "EU") {
		url = "https://log-api.eu.newrelic.com/log/v1"
	}

	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}

	return &NewrelicShipper{
		cfg: NewrelicConfig{
			LicenseKey: key,
			Region:     region,
			Service:    service,
		},
		url:    url,
		client: client,
	}
}

// SendDirect 将日志包直接发送到 New Relic。
func (s *NewrelicShipper) SendDirect(ctx context.Context, entries []NewrelicLogEntry) error {
	if s.cfg.LicenseKey == "" || len(entries) == 0 {
		return nil
	}

	payload := []newrelicPayloadBlock{
		{
			Common: newrelicPayloadCommon{
				Attributes: map[string]any{
					"service": s.cfg.Service,
					"plugin":  "drive-collector-go",
				},
			},
			Logs: entries,
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("newrelic: marshal error: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("newrelic: build request error: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Api-Key", s.cfg.LicenseKey)

	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("newrelic: send logs error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("newrelic: API returned status %d", resp.StatusCode)
	}
	return nil
}
