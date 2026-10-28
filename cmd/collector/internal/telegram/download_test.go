package telegram

import (
	"os"
	"path/filepath"
	"time"
	"testing"

	"github.com/gotd/td/tg"
)

// TestLocationOfDocumentCarriesCredentials 核心防退化用例:
// location 必须带上 AccessHash 和 FileReference。漏掉任何一个,
// Telegram 都会在 Stream 第一块时报错 AUTH_KEY_UNREGISTERED / FILE_REFERENCE_INVALID。
func TestLocationOfDocumentCarriesCredentials(t *testing.T) {
	doc := &tg.Document{
		ID:            42,
		AccessHash:    0xdeadbeef,
		FileReference: []byte{1, 2, 3, 4},
		Size:          1024,
	}
	f, err := locationOf(&tg.MessageMediaDocument{Document: doc})
	if err != nil {
		t.Fatal(err)
	}

	loc, ok := f.Location.(*tg.InputDocumentFileLocation)
	if !ok {
		t.Fatalf("location 类型 = %T,期望 *InputDocumentFileLocation", f.Location)
	}
	if loc.ID != 42 || loc.AccessHash != 0xdeadbeef || len(loc.FileReference) != 4 {
		t.Errorf("凭据未完整透传到 location:got %+v", loc)
	}
	if f.TotalSize != 1024 {
		t.Errorf("TotalSize = %d,want 1024", f.TotalSize)
	}
}

// TestLocationOfPhotoPicksLargestWithType 核心防退化用例:
// 照片有多档尺寸,必须选 Size 最大的那档,并且要把它的 Type 写进 ThumbSize。
// 只选大小不选 Type 会导致 InputPhotoFileLocation 填错。
func TestLocationOfPhotoPicksLargestWithType(t *testing.T) {
	photo := &tg.Photo{
		ID:            7,
		AccessHash:    0xcafe,
		FileReference: []byte{9, 9},
	}
	photo.Sizes = []tg.PhotoSizeClass{
		&tg.PhotoSize{Type: "s", W: 100, H: 100, Size: 1000},
		&tg.PhotoSize{Type: "y", W: 800, H: 600, Size: 50000},
		&tg.PhotoSize{Type: "m", W: 320, H: 240, Size: 8000},
	}

	f, err := locationOf(&tg.MessageMediaPhoto{Photo: photo})
	if err != nil {
		t.Fatal(err)
	}

	loc, ok := f.Location.(*tg.InputPhotoFileLocation)
	if !ok {
		t.Fatalf("location 类型 = %T", f.Location)
	}
	if loc.ThumbSize != "y" {
		t.Errorf("ThumbSize = %q,期望最大的那档 \"y\"", loc.ThumbSize)
	}
	if loc.AccessHash != 0xcafe || len(loc.FileReference) != 2 {
		t.Error("照片的 AccessHash / FileReference 丢了")
	}
	if f.TotalSize != 50000 {
		t.Errorf("TotalSize = %d,期望最大档的 50000", f.TotalSize)
	}
}

// TestLocationOfPhotoHandlesProgressive 渐进式 JPEG 也要能取到完整尺寸。
//
// PhotoSizeProgressive 没有 Size 字段,只有 Sizes 前缀数组 ——
// 只处理 PhotoSize 的话,这类图片会被判成「没有可用尺寸」而下载失败。
func TestLocationOfPhotoHandlesProgressive(t *testing.T) {
	photo := &tg.Photo{ID: 1, AccessHash: 2, FileReference: []byte{3}}
	photo.Sizes = []tg.PhotoSizeClass{
		&tg.PhotoSizeProgressive{Type: "y", W: 800, H: 600, Sizes: []int{100, 5000, 40000}},
	}

	f, err := locationOf(&tg.MessageMediaPhoto{Photo: photo})
	if err != nil {
		t.Fatal(err)
	}
	if f.TotalSize != 40000 {
		t.Errorf("TotalSize = %d,期望最后一个前缀 40000", f.TotalSize)
	}
	loc := f.Location.(*tg.InputPhotoFileLocation)
	if loc.ThumbSize != "y" {
		t.Errorf("ThumbSize = %q", loc.ThumbSize)
	}
}

// TestLocationOfWebPageDocument 测试从网页预览卡片中解包 Document 下载。
func TestLocationOfWebPageDocument(t *testing.T) {
	doc := &tg.Document{
		ID:            99,
		AccessHash:    0x1234,
		FileReference: []byte{5, 6},
		Size:          2048,
	}
	wp := &tg.WebPage{
		ID:       1,
		URL:      "https://example.com/video.mp4",
		Document: doc,
	}
	media := &tg.MessageMediaWebPage{Webpage: wp}

	f, err := locationOf(media)
	if err != nil {
		t.Fatalf("locationOf(MessageMediaWebPage doc) 报错: %v", err)
	}
	loc, ok := f.Location.(*tg.InputDocumentFileLocation)
	if !ok || loc.ID != 99 {
		t.Errorf("未正确解包出 Document: %+v", f.Location)
	}
	if f.TotalSize != 2048 {
		t.Errorf("TotalSize = %d, want 2048", f.TotalSize)
	}
}

// TestLocationOfWebPagePhoto 测试从网页预览卡片中解包 Photo 下载。
func TestLocationOfWebPagePhoto(t *testing.T) {
	photo := &tg.Photo{
		ID:            101,
		AccessHash:    0x5678,
		FileReference: []byte{7, 8},
		Sizes: []tg.PhotoSizeClass{
			&tg.PhotoSize{Type: "x", Size: 3000},
		},
	}
	wp := &tg.WebPage{
		ID:    2,
		URL:   "https://example.com/image.jpg",
		Photo: photo,
	}
	media := &tg.MessageMediaWebPage{Webpage: wp}

	f, err := locationOf(media)
	if err != nil {
		t.Fatalf("locationOf(MessageMediaWebPage photo) 报错: %v", err)
	}
	loc, ok := f.Location.(*tg.InputPhotoFileLocation)
	if !ok || loc.ID != 101 {
		t.Errorf("未正确解包出 Photo: %+v", f.Location)
	}
}

// TestLocationOfRejectsUnsupported 不支持的媒体类型必须明确报错。
//
// 静默返回空 location 会让下载请求带着 nil 发出去 —— 那正是
// 这次 panic 的形态。
func TestLocationOfRejectsUnsupported(t *testing.T) {
	for _, m := range []tg.MessageMediaClass{
		&tg.MessageMediaEmpty{},
		&tg.MessageMediaGeo{},
	} {
		if _, err := locationOf(m); err == nil {
			t.Errorf("%s 应报错", m.TypeName())
		}
	}
}

// TestLocationOfRejectsEmptyPhoto 没有尺寸的图片必须报错,不能返回空 location。
func TestLocationOfRejectsEmptyPhoto(t *testing.T) {
	photo := &tg.Photo{ID: 1, AccessHash: 2}

	if _, err := locationOf(&tg.MessageMediaPhoto{Photo: photo}); err == nil {
		t.Error("没有尺寸的图片应报错")
	}
}


func TestResolveChunkSize(t *testing.T) {
	if got := ResolveChunkSize(50 * 1024 * 1024); got != DefaultSmallChunkSize {
		t.Errorf("got %d, want %d", got, DefaultSmallChunkSize)
	}
	if got := ResolveChunkSize(200 * 1024 * 1024); got != DefaultLargeChunkSize {
		t.Errorf("got %d, want %d", got, DefaultLargeChunkSize)
	}
}

func TestCleanupStalePartFiles(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "part-cleanup-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	// 1. 创建未过期的 .part
	freshPart := filepath.Join(tmpDir, "task1.bin.part")
	if err := os.WriteFile(freshPart, []byte("fresh content"), 0o644); err != nil {
		t.Fatal(err)
	}

	// 2. 创建过期的 .part
	stalePart := filepath.Join(tmpDir, "task2.bin.part")
	if err := os.WriteFile(stalePart, []byte("stale content"), 0o644); err != nil {
		t.Fatal(err)
	}
	oldTime := time.Now().Add(-48 * time.Hour)
	_ = os.Chtimes(stalePart, oldTime, oldTime)

	// 3. 创建非 .part 文件（即使时间很旧也不应删除）
	regularFile := filepath.Join(tmpDir, "keepme.txt")
	if err := os.WriteFile(regularFile, []byte("regular"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(regularFile, oldTime, oldTime)

	removed, err := CleanupStalePartFiles(tmpDir, 24*time.Hour)
	if err != nil {
		t.Fatalf("CleanupStalePartFiles error: %v", err)
	}
	if removed != 1 {
		t.Fatalf("expected 1 removed file, got %d", removed)
	}

	if _, err := os.Stat(stalePart); !os.IsNotExist(err) {
		t.Errorf("stalePart should be deleted")
	}
	if _, err := os.Stat(freshPart); err != nil {
		t.Errorf("freshPart should still exist")
	}
	if _, err := os.Stat(regularFile); err != nil {
		t.Errorf("regularFile should still exist")
	}
}
