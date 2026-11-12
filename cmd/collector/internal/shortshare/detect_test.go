package shortshare

import (
	"reflect"
	"testing"
)

func TestExtractShortshareURLs(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []string
	}{
		{
			name:     "empty text",
			input:    "",
			expected: nil,
		},
		{
			name:     "single lurl",
			input:    "看这里 https://lurl.cc/abc123 好看",
			expected: []string{"https://lurl.cc/abc123"},
		},
		{
			name:     "single myppt",
			input:    "分享：http://www.myppt.cc/xyz789.",
			expected: []string{"http://www.myppt.cc/xyz789"},
		},
		{
			name:     "multiple links and duplicates",
			input:    "https://lurl.cc/aaa and https://myppt.cc/bbb and https://lurl.cc/aaa",
			expected: []string{"https://lurl.cc/aaa", "https://myppt.cc/bbb"},
		},
		{
			name:     "punctuation trailing",
			input:    "链接如下：(https://lurl.cc/test_code)！",
			expected: []string{"https://lurl.cc/test_code"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExtractShortshareURLs(tt.input)
			if !reflect.DeepEqual(got, tt.expected) {
				t.Errorf("ExtractShortshareURLs() = %v, want %v", got, tt.expected)
			}
		})
	}
}

func TestParseURL(t *testing.T) {
	tests := []struct {
		url        string
		wantDomain string
		wantCodeID string
		wantErr    bool
	}{
		{"https://lurl.cc/eR82b", "lurl.cc", "eR82b", false},
		{"http://www.myppt.cc/p917a", "myppt.cc", "p917a", false},
		{"https://example.com/123", "", "", true},
	}

	for _, tt := range tests {
		t.Run(tt.url, func(t *testing.T) {
			domain, code, err := ParseURL(tt.url)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseURL() error = %v, wantErr %v", err, tt.wantErr)
			}
			if domain != tt.wantDomain || code != tt.wantCodeID {
				t.Errorf("ParseURL() = (%v, %v), want (%v, %v)", domain, code, tt.wantDomain, tt.wantCodeID)
			}
		})
	}
}
