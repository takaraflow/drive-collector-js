package social

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestExtractSocialMediaURLs(t *testing.T) {
	text := `Check out this tweet: https://x.com/jack/status/20?s=20! Also https://www.tiktok.com/@user/video/1234567890 and text.`
	urls := ExtractSocialMediaURLs(text)
	if len(urls) != 2 {
		t.Fatalf("expected 2 urls, got %d: %v", len(urls), urls)
	}
	if urls[0] != "https://x.com/jack/status/20?s=20" {
		t.Errorf("url[0] = %q", urls[0])
	}
	if urls[1] != "https://www.tiktok.com/@user/video/1234567890" {
		t.Errorf("url[1] = %q", urls[1])
	}
}

func TestIsSocialMediaURL(t *testing.T) {
	cases := []struct {
		url  string
		want bool
	}{
		{"https://twitter.com/user/status/123456", true},
		{"https://x.com/user/status/123456?s=20", true},
		{"https://www.tiktok.com/@user/video/123456789", true},
		{"https://v.douyin.com/abc1234/", true},
		{"https://www.instagram.com/p/Cxyz123/", true},
		{"https://www.instagram.com/reel/Cxyz123/", true},
		{"https://www.threads.net/@user/post/Cxyz123", true},
		{"https://google.com", false},
		{"https://t.me/c/12345/6789", false},
	}

	for _, tc := range cases {
		got := IsSocialMediaURL(tc.url)
		if got != tc.want {
			t.Errorf("IsSocialMediaURL(%q) = %v, want %v", tc.url, got, tc.want)
		}
	}
}

func TestSanitizeFileName(t *testing.T) {
	name := `[X] user - test/video: "hello" *?| <world>_123.mp4`
	got := SanitizeFileName(name)
	want := `[X] user - test_video_ _hello_ _ _world__123.mp4`
	if got != want {
		t.Errorf("SanitizeFileName() = %q, want %q", got, want)
	}
}

func TestFxTwitterParser(t *testing.T) {
	mockResponse := `{
		"code": 200,
		"message": "OK",
		"tweet": {
			"id": "123456",
			"text": "Check out this video!",
			"author": {
				"name": "Test User",
				"screen_name": "testuser"
			},
			"media": {
				"videos": [
					{
						"type": "video",
						"url": "https://video.twimg.com/low.mp4",
						"variants": [
							{"bitrate": 832000, "content_type": "video/mp4", "url": "https://video.twimg.com/832k.mp4"},
							{"bitrate": 2176000, "content_type": "video/mp4", "url": "https://video.twimg.com/2176k.mp4"},
							{"bitrate": 256000, "content_type": "video/mp4", "url": "https://video.twimg.com/256k.mp4"}
						]
					}
				],
				"photos": [
					{"type": "photo", "url": "https://pbs.twimg.com/media/test.jpg"}
				]
			}
		}
	}`

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(mockResponse))
	}))
	defer server.Close()

	oldBase := fxTwitterBaseURL
	fxTwitterBaseURL = server.URL
	defer func() { fxTwitterBaseURL = oldBase }()

	res, err := fetchFxTwitter(context.Background(), server.Client(), "123456", "https://x.com/testuser/status/123456")
	if err != nil {
		t.Fatalf("fetchFxTwitter error: %v", err)
	}

	if res.Platform != "twitter" {
		t.Errorf("res.Platform = %q, want twitter", res.Platform)
	}
	if res.Author != "Test User" {
		t.Errorf("res.Author = %q, want Test User", res.Author)
	}
	if len(res.Media) != 2 {
		t.Fatalf("len(res.Media) = %d, want 2", len(res.Media))
	}

	// First item must be the highest bitrate variant (2176k)
	video := res.Media[0]
	if video.Type != "video" {
		t.Errorf("video.Type = %q, want video", video.Type)
	}
	if video.URL != "https://video.twimg.com/2176k.mp4" {
		t.Errorf("video.URL = %q, want https://video.twimg.com/2176k.mp4", video.URL)
	}
	if video.Quality != "2176k" {
		t.Errorf("video.Quality = %q, want 2176k", video.Quality)
	}

	// Second item must be the photo with ?name=orig
	photo := res.Media[1]
	if photo.Type != "photo" {
		t.Errorf("photo.Type = %q, want photo", photo.Type)
	}
	if photo.URL != "https://pbs.twimg.com/media/test.jpg?name=orig" {
		t.Errorf("photo.URL = %q, want https://pbs.twimg.com/media/test.jpg?name=orig", photo.URL)
	}
}

func TestTikTokAndDouyinParser(t *testing.T) {
	mockResponse := `{
		"code": 0,
		"msg": "success",
		"data": {
			"id": "7106594312292453675",
			"title": "Amazing Cat Video! Funny jumps",
			"play": "/video/720p.mp4",
			"hdplay": "/video/1080p_hd.mp4",
			"size": 5242880,
			"hd_size": 10485760,
			"author": {
				"nickname": "CatLover",
				"unique_id": "catlover99"
			},
			"images": [
				"https://p16.tiktokcdn.com/img1.jpg",
				"https://p16.tiktokcdn.com/img2.jpg"
			]
		}
	}`

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(mockResponse))
	}))
	defer server.Close()

	oldBase := tikWMBaseURL
	tikWMBaseURL = server.URL
	defer func() { tikWMBaseURL = oldBase }()

	// 1. 测试 TikTok 链接
	res, err := ParseTikTokOrDouyin(context.Background(), "https://www.tiktok.com/@tiktok/video/7106594312292453675")
	if err != nil {
		t.Fatalf("ParseTikTokOrDouyin error: %v", err)
	}
	if res.Platform != "tiktok" {
		t.Errorf("Platform = %q, want tiktok", res.Platform)
	}
	if res.Author != "CatLover" {
		t.Errorf("Author = %q, want CatLover", res.Author)
	}
	// 应包含 1 个 HD 视频和 2 张图片
	if len(res.Media) != 3 {
		t.Fatalf("len(res.Media) = %d, want 3", len(res.Media))
	}
	video := res.Media[0]
	if video.Quality != "1080p (HD)" {
		t.Errorf("video.Quality = %q, want 1080p (HD)", video.Quality)
	}
	if video.URL != server.URL+"/video/1080p_hd.mp4" {
		t.Errorf("video.URL = %q", video.URL)
	}

	// 2. 测试 抖音 链接 (平台判定为 douyin)
	resDouyin, err := ParseTikTokOrDouyin(context.Background(), "https://v.douyin.com/i8ABCD/")
	if err != nil {
		t.Fatalf("ParseTikTokOrDouyin douyin error: %v", err)
	}
	if resDouyin.Platform != "douyin" {
		t.Errorf("Platform = %q, want douyin", resDouyin.Platform)
	}
}
