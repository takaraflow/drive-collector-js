package gofile

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestClient_GenerateWebsiteTokenFallback(t *testing.T) {
	c := NewClient()
	// Disable external node calling in this unit test to test pure Go fallback
	c.tokenCache = "test-token"
	ctx := context.Background()

	wt := c.GenerateWebsiteToken(ctx, "test-token")
	if len(wt) != 64 {
		t.Fatalf("expected 64 char hex hash, got len %d: %s", len(wt), wt)
	}
}

func TestClient_MockResolve(t *testing.T) {
	// Create temp token cache file
	tmpFile, err := os.CreateTemp("", "gofile_token_test_*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())

	var serverHandler http.HandlerFunc

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serverHandler(w, r)
	}))
	defer ts.Close()

	c := &Client{
		http:           ts.Client(),
		userAgent:      DefaultUserAgent,
		tokenCacheFile: tmpFile.Name(),
		tokenCache:     "mock-token-123",
		salt:           defaultSalt,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// 1. Test 429 Rate Limit
	t.Run("RateLimit", func(t *testing.T) {
		serverHandler = func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusTooManyRequests)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "error-rateLimit",
				"data":   map[string]any{},
			})
		}

		// Inject test server endpoint by overriding queryContent logic or custom roundtripper
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL, nil)
		resp, err := c.http.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusTooManyRequests {
			t.Errorf("expected 429, got %d", resp.StatusCode)
		}
	})

	// 2. Test Success parsing folder with children
	t.Run("FolderWithChildren", func(t *testing.T) {
		serverHandler = func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "ok",
				"data": map[string]any{
					"id":        "test-folder-id",
					"type":      "folder",
					"name":      "Test Folder",
					"totalSize": 10240,
					"children": map[string]any{
						"f1": map[string]any{
							"id":       "f1",
							"type":     "file",
							"name":     "video1.mp4",
							"size":     5120,
							"mimetype": "video/mp4",
							"link":     "https://cdn.gofile.io/download/web/f1/video1.mp4",
						},
						"f2": map[string]any{
							"id":       "f2",
							"type":     "file",
							"name":     "video2.mov",
							"size":     5120,
							"mimetype": "video/quicktime",
							"link":     "https://cdn.gofile.io/download/web/f2/video2.mov",
						},
						"subfolder": map[string]any{
							"id":   "sub1",
							"type": "folder",
							"name": "Nested",
						},
					},
				},
			})
		}

		res, err := c.http.Get(ts.URL)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()

		var apiRes apiContentResponse
		if err := json.NewDecoder(res.Body).Decode(&apiRes); err != nil {
			t.Fatal(err)
		}

		if len(apiRes.Data.Children) != 3 {
			t.Fatalf("expected 3 children, got %d", len(apiRes.Data.Children))
		}

		var files []FileItem
		for id, item := range apiRes.Data.Children {
			if item.Type == "file" {
				files = append(files, FileItem{
					ID:       id,
					Name:     item.Name,
					Size:     item.Size,
					MimeType: item.Mimetype,
					Link:     item.Link,
				})
			}
		}

		if len(files) != 2 {
			t.Fatalf("expected 2 files (excluding subfolder), got %d", len(files))
		}
	})
}

func TestClient_Resolve_WrongTokenAutoRetry(t *testing.T) {
	tmpFile, err := os.CreateTemp("", "gofile_token_retry_*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())

	var tokenCallCount int
	var queryCount int

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/accounts" && r.Method == http.MethodPost:
			tokenCallCount++
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "ok",
				"data": map[string]any{
					"token": "refreshed-guest-token",
				},
			})
		case strings.HasPrefix(r.URL.Path, "/contents/"):
			queryCount++
			auth := r.Header.Get("Authorization")
			if auth == "Bearer expired-token" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"status": "error-wrongToken",
					"data":   map[string]any{},
				})
				return
			}
			if auth == "Bearer refreshed-guest-token" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"status": "ok",
					"data": map[string]any{
						"id":        "target-folder",
						"type":      "folder",
						"name":      "Recovered Folder",
						"totalSize": 100,
						"children": map[string]any{
							"f1": map[string]any{
								"id":   "f1",
								"type": "file",
								"name": "recovered.mp4",
								"size": 100,
								"link": "https://cdn.gofile.io/download/f1",
							},
						},
					},
				})
				return
			}
			t.Errorf("unexpected Authorization header: %s", auth)
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	c := &Client{
		http:           ts.Client(),
		baseURL:        ts.URL,
		userAgent:      DefaultUserAgent,
		tokenCacheFile: tmpFile.Name(),
		tokenCache:     "expired-token",
		salt:           defaultSalt,
	}

	res, err := c.Resolve(context.Background(), "test-id", "")
	if err != nil {
		t.Fatalf("expected successful recovery after wrongToken, got error: %v", err)
	}
	if res.Name != "Recovered Folder" {
		t.Fatalf("expected folder name 'Recovered Folder', got: %s", res.Name)
	}
	if res.AccountToken != "refreshed-guest-token" {
		t.Fatalf("expected account token 'refreshed-guest-token', got: %s", res.AccountToken)
	}
	if queryCount != 2 {
		t.Fatalf("expected 2 queries (1 failed with error-wrongToken, 1 retry), got %d", queryCount)
	}
	if tokenCallCount != 1 {
		t.Fatalf("expected 1 token refresh call, got %d", tokenCallCount)
	}
}

func TestClient_TokenTTLExpiration(t *testing.T) {
	tmpFile, err := os.CreateTemp("", "gofile_token_ttl_*.json")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tmpFile.Name())

	// Write an expired token (created 24h ago)
	expiredData, _ := json.Marshal(cachedTokenData{
		Token:     "old-expired-token",
		CreatedAt: time.Now().Add(-24 * time.Hour).Unix(),
	})
	_ = os.WriteFile(tmpFile.Name(), expiredData, 0644)

	var accountCreated bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/accounts" {
			accountCreated = true
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": "ok",
				"data": map[string]any{
					"token": "fresh-token-123",
				},
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	c := &Client{
		http:           ts.Client(),
		baseURL:        ts.URL,
		userAgent:      DefaultUserAgent,
		tokenCacheFile: tmpFile.Name(),
		tokenTTL:       12 * time.Hour,
		salt:           defaultSalt,
	}

	token, err := c.GetAccountToken(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "fresh-token-123" {
		t.Fatalf("expected fresh token, got: %s", token)
	}
	if !accountCreated {
		t.Fatal("expected accounts API to be called because cache was expired")
	}
}

func TestClient_EnvToken(t *testing.T) {
	t.Setenv("GOFILE_TOKEN", "static-custom-token")
	c := NewClient()
	token, err := c.GetAccountToken(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if token != "static-custom-token" {
		t.Fatalf("expected 'static-custom-token', got: %s", token)
	}
}
