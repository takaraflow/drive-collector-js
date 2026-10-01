package telegram

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/gotd/td/tg"
)

// ProgressFunc 接收下载进度(0..1)。
type ProgressFunc func(ratio float64)

// DownloadTo 把 chatID 里的 msgID 号消息下载到 destPath。
//
// 流程:按 message id 取回消息 → 从 media 解析出 InputFileLocation →
// 流式写盘。
//
// 取回而不是直接下载,是因为 gotd 没有「给个 message id 就能下」
// 的快捷 API —— location 必须从 media 对象里解析,而 update 里的
// Message 在很多路径上被标记为已消费(不能重放),所以必须重新取。
func (c *Client) DownloadTo(ctx context.Context, chatID, msgID int64, destPath string, progress ProgressFunc) error {
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return fmt.Errorf("telegram: 创建下载目录失败: %w", err)
	}

	msg, err := c.fetchMessage(ctx, chatID, msgID)
	if err != nil {
		return err
	}

	media, ok := msg.GetMedia()
	if !ok || media == nil {
		return fmt.Errorf("telegram: 消息 %d 没有媒体,无法下载", msgID)
	}
	loc, err := locationOf(media)
	if err != nil {
		return err
	}

	// 先下到临时文件,成功后再 rename —— 直接写目标路径时,
	// 中途失败会留下半截文件,而后续流程会把它当成有效文件上传,
	// 用户拿到的是损坏的文件。
	tmp, err := os.CreateTemp(filepath.Dir(destPath), ".dl-*")
	if err != nil {
		return fmt.Errorf("telegram: 创建临时文件失败: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() {
		tmp.Close()
		// rename 成功后这里删的是已经不存在的路径,无害。
		_ = os.Remove(tmpPath)
	}()

	writer := &progressWriter{w: tmp, total: loc.TotalSize, progress: progress}
	builder := c.tg.Downloader().Download(nil, loc.Location)
	if _, err := builder.Stream(ctx, writer); err != nil {
		return fmt.Errorf("telegram: 下载失败: %w", err)
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("telegram: 写盘失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("telegram: 关闭临时文件失败: %w", err)
	}
	if err := os.Rename(tmpPath, destPath); err != nil {
		return fmt.Errorf("telegram: 落盘到目标路径失败: %w", err)
	}
	return nil
}

// fetchMessage 取回指定消息。
func (c *Client) fetchMessage(ctx context.Context, chatID, msgID int64) (*tg.Message, error) {
	messages, err := c.tg.API().MessagesGetMessages(ctx,
		[]tg.InputMessageClass{&tg.InputMessageID{ID: int(msgID)}})
	if err != nil {
		return nil, fmt.Errorf("telegram: 取消息 %d 失败: %w", msgID, err)
	}

	// 返回的是 MessagesClass,可能是 Messages / MessagesCombined / 空
	switch v := messages.(type) {
	case *tg.MessagesMessages:
		if len(v.Messages) == 0 {
			return nil, fmt.Errorf("telegram: 消息 %d 不存在或已被删除", msgID)
		}
		msg, ok := v.Messages[0].(*tg.Message)
		if !ok {
			return nil, fmt.Errorf("telegram: 消息 %d 内容为空", msgID)
		}
		return msg, nil
	default:
		// 其余变体(频道消息被折叠等)不支持 —— 明确报错优于静默失败。
		return nil, fmt.Errorf("telegram: 消息 %d 的容器类型暂不支持(%s)", msgID, messages.TypeName())
	}
}

// file 是 gotd 的下载元数据。
type file struct {
	Location  tg.InputFileLocationClass
	TotalSize int64
}

// locationOf 从 MessageMedia 解析出可下载的位置。
func locationOf(m tg.MessageMediaClass) (file, error) {
	switch v := m.(type) {
	case *tg.MessageMediaDocument:
		doc, ok := v.Document.(*tg.Document)
		if !ok {
			return file{}, fmt.Errorf("telegram: 文档内容为空")
		}
		return file{
			Location:  &tg.InputDocumentFileLocation{ID: doc.GetID()},
			TotalSize: doc.GetSize(),
		}, nil

	case *tg.MessageMediaPhoto:
		photo, ok := v.Photo.(*tg.Photo)
		if !ok {
			return file{}, fmt.Errorf("telegram: 图片内容为空")
		}
		// 图片有多档尺寸,取最大的那档
		sizes := photo.GetSizes()
		if len(sizes) == 0 {
			return file{}, fmt.Errorf("telegram: 图片没有可用尺寸")
		}
		bestSize := int64(0)
		for _, ps := range sizes {
			concrete, ok := ps.(*tg.PhotoSize)
			if !ok {
				continue
			}
			if int64(concrete.Size) > bestSize {
				bestSize = int64(concrete.Size)
			}
		}
		return file{
			Location:  &tg.InputPhotoFileLocation{ID: photo.GetID()},
			TotalSize: bestSize,
		}, nil

	default:
		return file{}, fmt.Errorf("telegram: 该媒体类型(%s)暂不支持直接下载", m.TypeName())
	}
}

// progressWriter 包一层 io.Writer 汇报进度。
//
// 刻意用 bufio 包一层再写 —— 直接 Write 会让每个分片都触发一次
// 系统调用,大文件下 syscall 数量会成为瓶颈。
type progressWriter struct {
	w        *os.File
	total    int64
	written  int64
	progress ProgressFunc
	buf      []byte
}

func (p *progressWriter) Write(b []byte) (int, error) {
	if len(p.buf)+len(b) > 32*1024 {
		if err := p.flush(); err != nil {
			return 0, err
		}
	}
	p.buf = append(p.buf, b...)
	return len(b), nil
}

func (p *progressWriter) flush() error {
	if len(p.buf) == 0 {
		return nil
	}
	n, err := p.w.Write(p.buf)
	p.written += int64(n)
	p.buf = p.buf[:0]
	if p.progress != nil && p.total > 0 {
		p.progress(float64(p.written) / float64(p.total))
	}
	return err
}

// Close 必须 flush 缓冲 —— 否则最后不满一块的数据会丢,
// 表现为「文件比预期小」,而那正是 PR#458 踩过的坑的变体。
func (p *progressWriter) Close() error { return p.flush() }
