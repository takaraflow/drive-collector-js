package gofile

import (
	"testing"
)

func TestExtractGofileURLs(t *testing.T) {
	text := `Hello, check this folder: https://gofile.io/d/bjpcBx9H, and another one (https://www.gofile.io/d/abc123XYZ).
Also ignore http://other-site.com/d/123 and duplicate https://gofile.io/d/bjpcBx9H`

	urls := ExtractGofileURLs(text)
	if len(urls) != 2 {
		t.Fatalf("expected 2 URLs, got %d: %v", len(urls), urls)
	}

	if urls[0] != "https://gofile.io/d/bjpcBx9H" {
		t.Errorf("urls[0] = %s, want https://gofile.io/d/bjpcBx9H", urls[0])
	}
	if urls[1] != "https://www.gofile.io/d/abc123XYZ" {
		t.Errorf("urls[1] = %s, want https://www.gofile.io/d/abc123XYZ", urls[1])
	}
}

func TestExtractContentID(t *testing.T) {
	cases := []struct {
		url      string
		expected string
	}{
		{"https://gofile.io/d/bjpcBx9H", "bjpcBx9H"},
		{"http://www.gofile.io/d/folder_123", "folder_123"},
		{"https://gofile.io/d/invalid#anchor", "invalid"},
		{"https://example.com/d/123", ""},
	}

	for _, c := range cases {
		id := ExtractContentID(c.url)
		if id != c.expected {
			t.Errorf("ExtractContentID(%q) = %q, want %q", c.url, id, c.expected)
		}
	}
}
