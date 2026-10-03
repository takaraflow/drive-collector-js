package telegram

import (
	"testing"

	"github.com/gotd/td/tg"
)

// TestLocationOfDocumentCarriesCredentials 是这次生产 panic 的回归测试。
//
// 生产实测:每次下载都 SIGSEGV,容器反复重启。根因是
// `Downloader().Download(nil, loc)` —— 第一个参数是 RPC client,
// 传 nil 会在 master.Chunk 里解引用 nil 接口。
//
// 但同一段代码还有第二个更隐蔽的问题:location 是自己拼的
// `&InputDocumentFileLocation{ID: doc.ID}`,少了 AccessHash 和
// FileReference。Telegram 会拒绝这种请求 —— 而拒绝发生在网络层,
// 表现为「下载失败」而不是「参数错了」,排查时很容易走偏。
//
// 这个测试守住后者:location 必须带上全部三个凭据。
func TestLocationOfDocumentCarriesCredentials(t *testing.T) {
	doc := &tg.Document{
		ID:            42,
		AccessHash:    0xdeadbeef,
		FileReference: []byte{1, 2, 3, 4},
		Size:          2048,
	}

	f, err := locationOf(&tg.MessageMediaDocument{Document: doc})
	if err != nil {
		t.Fatal(err)
	}

	loc, ok := f.Location.(*tg.InputDocumentFileLocation)
	if !ok {
		t.Fatalf("location 类型 = %T,期望 *InputDocumentFileLocation", f.Location)
	}
	if loc.ID != 42 {
		t.Errorf("ID = %d", loc.ID)
	}
	if loc.AccessHash != 0xdeadbeef {
		t.Errorf("AccessHash 丢了 —— Telegram 会拒绝下载(错误发生在网络层,很难定位)")
	}
	if len(loc.FileReference) != 4 {
		t.Errorf("FileReference 丢了 —— 它是服务端下发的一次性凭据,只能从消息里带出来")
	}
	if loc.ThumbSize != "" {
		t.Errorf("ThumbSize = %q,要文件本体时必须是空串", loc.ThumbSize)
	}
	if f.TotalSize != 2048 {
		t.Errorf("TotalSize = %d", f.TotalSize)
	}
}

// TestLocationOfPhotoPicksLargestWithType 图片必须取最大档,且带上它的 Type。
//
// InputPhotoFileLocation.ThumbSize 要填的是 PhotoSize.Type(如 "y"、"x"),
// 不是尺寸数字。只取 Size 不取 Type 的话,请求会指向一个不存在的尺寸。
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
		t.Error("图片的 AccessHash / FileReference 丢了")
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
