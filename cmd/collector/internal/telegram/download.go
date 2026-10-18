package telegram

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/gotd/td/tg"
)

// DownloadIdleTimeout 是下载数据传输的最大空闲无响应时间。
// 超过该时间仍无任何数据块到达，视为网络半开或挂死，主动取消中断。
const DownloadIdleTimeout = 60 * time.Second

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

	// 传输空闲看门狗：如果超过 DownloadIdleTimeout 无任何数据写入，主动取消，防止连接半开挂起。
	idleCtx, cancelIdle := context.WithCancel(ctx)
	defer cancelIdle()

	idleTimer := time.AfterFunc(DownloadIdleTimeout, func() {
		cancelIdle()
	})
	defer idleTimer.Stop()

	resetIdle := func() {
		idleTimer.Reset(DownloadIdleTimeout)
	}

	writer := &progressWriter{
		w:          tmp,
		total:      loc.TotalSize,
		progress:   progress,
		onActivity: resetIdle,
	}
	builder := c.tg.Downloader().Download(c.tg.API(), loc.Location)
	if _, err := builder.Stream(idleCtx, writer); err != nil {
		if idleCtx.Err() != nil && ctx.Err() == nil {
			return fmt.Errorf("telegram: 下载空闲超时(超过 %v 无数据传输)", DownloadIdleTimeout)
		}
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
	// 如果是频道 ID，必须通过 ChannelsGetMessages 获取，严禁走 MessagesGetMessages 混淆私聊
	if chID, isChannel := ParseChannelID(chatID); isChannel {
		hash, ok := c.peers.getChannel(chID)
		if !ok && c.tg != nil {
			dialogs, err := c.tg.API().MessagesGetDialogs(ctx, &tg.MessagesGetDialogsRequest{Limit: 100})
			if err == nil && dialogs != nil {
				if mod, isMod := dialogs.AsModified(); isMod {
					c.peers.storeChannels(mod.GetChats())
					hash, ok = c.peers.getChannel(chID)
				}
			}
		}
		if !ok {
			return nil, fmt.Errorf("telegram: 缺少频道 %d 的 accessHash，无法下载消息 %d", chID, msgID)
		}
		messages, err := c.tg.API().ChannelsGetMessages(ctx, &tg.ChannelsGetMessagesRequest{
			Channel: &tg.InputChannel{ChannelID: chID, AccessHash: hash},
			ID:      []tg.InputMessageClass{&tg.InputMessageID{ID: int(msgID)}},
		})
		if err != nil {
			return nil, fmt.Errorf("telegram: 取频道 %d 消息 %d 失败: %w", chID, msgID, err)
		}
		raw, known := extractMessages(messages)
		if !known {
			return nil, fmt.Errorf("telegram: 频道消息 %d 的容器类型暂不支持(%T)", msgID, messages)
		}
		if len(raw) == 0 {
			return nil, fmt.Errorf("telegram: 频道消息 %d 不存在或已被删除", msgID)
		}
		msg, ok := raw[0].(*tg.Message)
		if !ok {
			return nil, fmt.Errorf("telegram: 频道消息 %d 内容为空", msgID)
		}
		return msg, nil
	}

	messages, err := c.tg.API().MessagesGetMessages(ctx,
		[]tg.InputMessageClass{&tg.InputMessageID{ID: int(msgID)}})
	if err != nil {
		return nil, fmt.Errorf("telegram: 取消息 %d 失败: %w", msgID, err)
	}

	raw, known := extractMessages(messages)
	if !known {
		return nil, fmt.Errorf("telegram: 消息 %d 的容器类型暂不支持(%s)", msgID, messages.TypeName())
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("telegram: 消息 %d 不存在或已被删除", msgID)
	}
	msg, ok := raw[0].(*tg.Message)
	if !ok {
		return nil, fmt.Errorf("telegram: 消息 %d 内容为空", msgID)
	}
	return msg, nil
}

// file 是 gotd 的下载元数据。
type file struct {
	Location  tg.InputFileLocationClass
	TotalSize int64
}

// locationOf 从 MessageMedia 解析出可下载的位置。
//
// 必须用 gotd 的 As*FileLocation helper,不能自己拼结构体:
// InputDocumentFileLocation / InputPhotoFileLocation 除了 ID 还要
// AccessHash 和 FileReference,少任何一个 Telegram 都会拒绝下载。
// 而 FileReference 是服务端下发的、会过期的凭据 —— 只能从消息里带出来。
func locationOf(m tg.MessageMediaClass) (file, error) {
	switch v := m.(type) {
	case *tg.MessageMediaDocument:
		doc, ok := v.Document.(*tg.Document)
		if !ok {
			return file{}, fmt.Errorf("telegram: 文档内容为空")
		}
		// thumbSize 传空串 = 要文件本体,不是缩略图。
		return file{
			Location:  doc.AsInputDocumentFileLocation(""),
			TotalSize: doc.GetSize(),
		}, nil

	case *tg.MessageMediaPhoto:
		photo, ok := v.Photo.(*tg.Photo)
		if !ok {
			return file{}, fmt.Errorf("telegram: 图片内容为空")
		}
		// 图片有多档尺寸,取最大的那档 —— 但必须同时记住它的 Type,
		// 因为 InputPhotoFileLocation.ThumbSize 要填的就是这个 Type。
		// 只取 Size 不取 Type 的话,下载请求会指向一个不存在的尺寸。
		bestType, bestSize := "", int64(0)
		for _, ps := range photo.GetSizes() {
			switch s := ps.(type) {
			case *tg.PhotoSize:
				if int64(s.Size) > bestSize {
					bestType, bestSize = s.Type, int64(s.Size)
				}
			case *tg.PhotoSizeProgressive:
				// 渐进式 JPEG:最后一个前缀就是完整图。
				if n := len(s.Sizes); n > 0 {
					if full := int64(s.Sizes[n-1]); full > bestSize {
						bestType, bestSize = s.Type, full
					}
				}
			}
		}
		if bestType == "" {
			return file{}, fmt.Errorf("telegram: 图片没有可用尺寸")
		}
		return file{
			Location:  photo.AsInputPhotoFileLocation(bestType),
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
	w          *os.File
	total      int64
	written    int64
	progress   ProgressFunc
	onActivity func()
	buf        []byte
}

func (p *progressWriter) Write(b []byte) (int, error) {
	if p.onActivity != nil && len(b) > 0 {
		p.onActivity()
	}
	n, err := p.w.Write(b)
	p.written += int64(n)
	if p.progress != nil && p.total > 0 {
		p.progress(float64(p.written) / float64(p.total))
	}
	return n, err
}

func (p *progressWriter) Close() error {
	return nil
}
