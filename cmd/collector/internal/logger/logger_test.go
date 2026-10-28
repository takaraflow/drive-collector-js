package logger

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDatadogShipper(t *testing.T) {
	var receivedHeader string
	var receivedEntries []DatadogLogEntry

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedHeader = r.Header.Get("Content-Type")
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &receivedEntries)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	shipper := &DatadogShipper{
		cfg: DatadogConfig{
			APIKey:  "test-api-key",
			Service: "test-service",
		},
		url:    server.URL,
		client: server.Client(),
	}

	entries := []DatadogLogEntry{
		{
			Message: "test log 1",
			Status:  "info",
			Service: "test-service",
		},
	}

	err := shipper.SendDirect(context.Background(), entries)
	if err != nil {
		t.Fatalf("SendDirect failed: %v", err)
	}

	if receivedHeader != "application/json" {
		t.Errorf("expected Content-Type application/json, got %q", receivedHeader)
	}
	if len(receivedEntries) != 1 || receivedEntries[0].Message != "test log 1" {
		t.Errorf("unexpected received entries: %+v", receivedEntries)
	}
}

func TestNewrelicShipper(t *testing.T) {
	var apiKeyHeader string
	var receivedPayload []newrelicPayloadBlock

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		apiKeyHeader = r.Header.Get("Api-Key")
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &receivedPayload)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	shipper := &NewrelicShipper{
		cfg: NewrelicConfig{
			LicenseKey: "nr-test-license-key",
			Region:     "US",
			Service:    "collector-test",
		},
		url:    server.URL,
		client: server.Client(),
	}

	entries := []NewrelicLogEntry{
		{
			Message:  "error happened",
			Severity: "ERROR",
			Level:    "error",
		},
	}

	err := shipper.SendDirect(context.Background(), entries)
	if err != nil {
		t.Fatalf("SendDirect failed: %v", err)
	}

	if apiKeyHeader != "nr-test-license-key" {
		t.Errorf("expected Api-Key header 'nr-test-license-key', got %q", apiKeyHeader)
	}
	if len(receivedPayload) != 1 || len(receivedPayload[0].Logs) != 1 {
		t.Fatalf("unexpected payload structure: %+v", receivedPayload)
	}
	if receivedPayload[0].Logs[0].Message != "error happened" {
		t.Errorf("unexpected message: %q", receivedPayload[0].Logs[0].Message)
	}
}

func TestNewrelicShipperRegionURL(t *testing.T) {
	euShipper := NewNewrelicShipper(NewrelicConfig{
		LicenseKey: "key",
		Region:     "EU",
	})
	if euShipper.url != "https://log-api.eu.newrelic.com/log/v1" {
		t.Errorf("EU URL mismatch: got %q", euShipper.url)
	}

	usShipper := NewNewrelicShipper(NewrelicConfig{
		LicenseKey: "key",
		Region:     "US",
	})
	if usShipper.url != "https://log-api.newrelic.com/log/v1" {
		t.Errorf("US URL mismatch: got %q", usShipper.url)
	}
}
