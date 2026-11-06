//go:build smoke

package gofile

import (
	"context"
	"io"
	"net/http"
	"testing"
	"time"
)

func TestSmoke_LiveGofile(t *testing.T) {
	client := NewClient()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()

	t.Log("[SMOKE] 1. Resolving live Gofile folder bjpcBx9H...")
	res, err := client.Resolve(ctx, "bjpcBx9H", "")
	if err != nil {
		t.Skipf("Live Gofile API temporarily unreachable from this test runner: %v", err)
		return
	}

	t.Logf("[SMOKE] Folder resolved: %s (Total size: %d, Files count: %d)", res.Name, res.TotalSize, res.ItemCount)
	if len(res.Files) == 0 {
		t.Fatalf("expected files, got 0")
	}

	for i, f := range res.Files {
		t.Logf("  %d. %s (%d bytes)", i+1, f.Name, f.Size)
	}

	first := res.Files[0]
	t.Logf("[SMOKE] 2. Testing direct authenticated stream for %s...", first.Name)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, first.Link, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("User-Agent", DefaultUserAgent)
	req.Header.Set("Cookie", "accountToken="+res.AccountToken)
	req.Header.Set("Range", "bytes=0-1023")

	httpCli := &http.Client{Timeout: 10 * time.Second}
	resp, err := httpCli.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("Unexpected HTTP status: %d", resp.StatusCode)
	}

	buf, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}

	if len(buf) == 0 {
		t.Fatalf("received 0 bytes")
	}
	t.Logf("[SMOKE] Successfully received %d bytes from download stream! HTTP Status: %d", len(buf), resp.StatusCode)
	t.Log("[SMOKE] LIVE SMOKE TEST PASSED!")
}
