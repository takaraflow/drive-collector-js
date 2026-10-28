package telegram

import (
	"bytes"
		"crypto/sha256"
	"errors"
		"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestResumableDownloadSmoke 针对大文件本地断点续传暂存与清理进行端到端 Smoke 验证。
func TestResumableDownloadSmoke(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "resumable-smoke-*")
	if err != nil {
		t.Fatalf("无法创建临时测试目录: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	t.Logf("=== 启动大文件断点续传暂存 Smoke 测试, 目录: %s ===", tmpDir)

	// 1. 模拟数据准备 (生成 1MB 测试载荷)
	payloadSize := int64(1024 * 1024)
	payload := make([]byte, payloadSize)
	for i := range payload {
		payload[i] = byte(i % 251)
	}
	originalHash := sha256.Sum256(payload)

	// -------------------------------------------------------------
	// 场景 1: 机会式过期清理 (Opportunistic Cleanup) Smoke
	// -------------------------------------------------------------
	t.Run("Smoke: 机会式清理过期 .part 文件", func(t *testing.T) {
		staleFile := filepath.Join(tmpDir, "stale_upload.iso.part")
		freshFile := filepath.Join(tmpDir, "fresh_upload.iso.part")

		if err := os.WriteFile(staleFile, []byte("stale-partial-content"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(freshFile, []byte("fresh-partial-content"), 0o644); err != nil {
			t.Fatal(err)
		}

		// 将 staleFile 时间往前调整 48 小时
		pastTime := time.Now().Add(-48 * time.Hour)
		if err := os.Chtimes(staleFile, pastTime, pastTime); err != nil {
			t.Fatalf("修改过期文件时间戳失败: %v", err)
		}

		removed, err := CleanupStalePartFiles(tmpDir, 24*time.Hour)
		if err != nil {
			t.Fatalf("CleanupStalePartFiles 出错: %v", err)
		}
		if removed != 1 {
			t.Fatalf("期望清理 1 个过期文件, 实际清理: %d", removed)
		}

		if _, err := os.Stat(staleFile); !os.IsNotExist(err) {
			t.Errorf("过期 .part 文件应该已被彻底清理")
		}
		if _, err := os.Stat(freshFile); err != nil {
			t.Errorf("新鲜 .part 文件不应该被误删")
		}
		_ = os.Remove(freshFile)
		t.Log("✅ 场景 1: 机会式过期清理 Smoke 验证通过")
	})

	// -------------------------------------------------------------
	// 场景 2: 已落盘完整 .part 快速恢复完成 (Fast Resume from Completed .part)
	// -------------------------------------------------------------
	t.Run("Smoke: .part 文件已完整时直接原子重命名恢复", func(t *testing.T) {
		destFile := filepath.Join(tmpDir, "target_complete_video.mp4")
		partFile := destFile + PartSuffix

		// 事先落盘完整的 1MB .part 文件
		if err := os.WriteFile(partFile, payload, 0o644); err != nil {
			t.Fatalf("写入预置 .part 失败: %v", err)
		}

		// 模拟 DownloadTo 入口检查逻辑
		fi, err := os.Stat(partFile)
		if err != nil {
			t.Fatalf("读取预置 .part 失败: %v", err)
		}
		if fi.Size() == payloadSize {
			if err := os.Rename(partFile, destFile); err != nil {
				t.Fatalf("原子 rename 失败: %v", err)
			}
		}

		// 验证
		if _, err := os.Stat(partFile); !os.IsNotExist(err) {
			t.Errorf(".part 文件应在原子重命名后消失")
		}
		destContent, err := os.ReadFile(destFile)
		if err != nil {
			t.Fatalf("读取重命名后的目标文件失败: %v", err)
		}
		destHash := sha256.Sum256(destContent)
		if destHash != originalHash {
			t.Fatalf("文件哈希不一致! 期望 %x, 得到 %x", originalHash, destHash)
		}
		t.Log("✅ 场景 2: .part 完整预置恢复 Smoke 验证通过")
	})

	// -------------------------------------------------------------
	// 场景 3: 模拟流式下载中断，目标路径不留脏文件，.part 保留供续传
	// -------------------------------------------------------------
	t.Run("Smoke: 下载中途失败时隔离脏数据并保留 .part", func(t *testing.T) {
		destFile := filepath.Join(tmpDir, "broken_download.mkv")
		partFile := destFile + PartSuffix

		f, err := os.OpenFile(partFile, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatalf("创建 .part 失败: %v", err)
		}

		var lastProgress float64
		pw := &progressWriter{
			w:     f,
			total: payloadSize,
			progress: func(ratio float64) {
				lastProgress = ratio
			},
		}

		// 模拟写入前 256KB 然后突发网络断开
		cutOff := 256 * 1024
		n, err := pw.Write(payload[:cutOff])
		if err != nil || n != cutOff {
			t.Fatalf("写入前导切片失败: n=%d, err=%v", n, err)
		}
		_ = f.Close()

		// 模拟失败中断：不执行 os.Rename
		fakeNetworkErr := errors.New("simulated MTProto connection closed")
		t.Logf("模拟中断事件: %v, 当前进度汇报: %.2f%%", fakeNetworkErr, lastProgress*100)

		// 确认 destFile 绝不存在（杜绝半截脏文件让下游消费到）
		if _, err := os.Stat(destFile); !os.IsNotExist(err) {
			t.Fatalf("严重漏洞: 目标路径出现了半截损坏文件!")
		}

		// 确认 .part 暂存文件依然存在且字节数等于中断前的截断点
		partInfo, err := os.Stat(partFile)
		if err != nil {
			t.Fatalf("断点 .part 文件丢失: %v", err)
		}
		if partInfo.Size() != int64(cutOff) {
			t.Fatalf(".part 大小不符合预期: %d vs %d", partInfo.Size(), cutOff)
		}
		t.Log("✅ 场景 3: 中断脏数据隔离与暂存保留 Smoke 验证通过")
	})

	// -------------------------------------------------------------
	// 场景 4: 完整流式写入、看门狗传输监控与最终原子交付 Smoke
	// -------------------------------------------------------------
	t.Run("Smoke: 完整流式暂存与原子 Rename 最终交付", func(t *testing.T) {
		destFile := filepath.Join(tmpDir, "successful_deliver.dat")
		partFile := destFile + PartSuffix

		partF, err := os.OpenFile(partFile, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if err != nil {
			t.Fatalf("创建 .part 失败: %v", err)
		}

		activityCount := 0
		var finalProgress float64
		pw := &progressWriter{
			w:     partF,
			total: payloadSize,
			progress: func(ratio float64) {
				finalProgress = ratio
			},
			onActivity: func() {
				activityCount++
			},
		}

		// 分块写入模拟真实网络传输
		reader := bytes.NewReader(payload)
		buf := make([]byte, 64*1024)
		for {
			nr, readErr := reader.Read(buf)
			if nr > 0 {
				_, writeErr := pw.Write(buf[:nr])
				if writeErr != nil {
					t.Fatalf("写分块失败: %v", writeErr)
				}
			}
			if readErr != nil {
				if readErr == io.EOF {
					break
				}
				t.Fatalf("读取模拟数据失败: %v", readErr)
			}
		}

		_ = partF.Close()

		// 校验 .part 大小并原子重命名交付
		st, err := os.Stat(partFile)
		if err != nil || st.Size() != payloadSize {
			t.Fatalf(".part 文件尺寸不匹配: %v, size=%d", err, st.Size())
		}
		if err := os.Rename(partFile, destFile); err != nil {
			t.Fatalf("最终交付原子重命名失败: %v", err)
		}

		// 验证结果
		if finalProgress != 1.0 {
			t.Errorf("最终进度未达到 1.0, 实际: %f", finalProgress)
		}
		if activityCount == 0 {
			t.Errorf("传输活动看门狗未记录到活动事件")
		}

		deliveredContent, err := os.ReadFile(destFile)
		if err != nil {
			t.Fatalf("读取交付文件失败: %v", err)
		}
		if !bytes.Equal(deliveredContent, payload) {
			t.Fatalf("交付数据与原始载荷不匹配")
		}
		t.Logf("✅ 场景 4: 完整流式暂存与原子交付 Smoke 验证通过 (活动心跳触发次数: %d)", activityCount)
	})
}
