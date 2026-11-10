package app

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/youngsx/drive-collector/cmd/collector/internal/rclone"
)

var indexedNameRegex = regexp.MustCompile(`^(.+)\s+\((\d+)\)$`)

// ConflictResolution 描述针对目标网盘的同名检测与冲突消解结果。
type ConflictResolution struct {
	// TargetFileName 最终应在网盘上保存的文件名。
	TargetFileName string
	// ShouldSkip 是否命中已存在且大小完全相同的副本（秒传/跳过，无需实际上传）。
	ShouldSkip bool
	// IsRenamed 是否因为同名但不同内容触发了序号重命名（防止静默覆盖）。
	IsRenamed bool
}

// resolveUploadConflict 在执行上传前，对比远端现有文件清单与待上传文件：
//
// 1. 同名且大小完全一致（incomingSize > 0 且精确相等）：
//    命中远端已有文件，跳过实际传输（ShouldSkip = true），返回原文件名。
//
// 2. 同名但大小不一致（或 incomingSize <= 0 无法确定内容）：
//    存在数据覆盖损毁风险，自动派生递增序号候选名（如 "name (1).ext"）。
//    - 若候选名已存在且大小匹配，直接命中该序号文件的秒传（ShouldSkip = true）；
//    - 若候选名不存在，选用该候选名上传（IsRenamed = true, ShouldSkip = false）。
//
// 3. 远端不存在同名文件：
//    直接使用原文件名上传（ShouldSkip = false, IsRenamed = false）。
func resolveUploadConflict(remoteFiles []rclone.FileEntry, desiredName string, incomingSize int64) ConflictResolution {
	cleanName := strings.TrimSpace(desiredName)
	if cleanName == "" {
		cleanName = "file"
	}

	exactMap := make(map[string]int64, len(remoteFiles))
	lowerMap := make(map[string]int64, len(remoteFiles))

	for _, entry := range remoteFiles {
		if entry.IsDir {
			continue
		}
		exactMap[entry.Name] = entry.Size
		lowerMap[strings.ToLower(entry.Name)] = entry.Size
	}

	cleanLower := strings.ToLower(cleanName)
	existingSize, hasExact := exactMap[cleanName]
	if !hasExact {
		existingSize, hasExact = lowerMap[cleanLower]
	}

	// 1. 远端完全没有重名文件
	if !hasExact {
		return ConflictResolution{
			TargetFileName: cleanName,
			ShouldSkip:     false,
			IsRenamed:      false,
		}
	}

	// 2. 远端存在重名文件且精确大小一致 -> 秒传跳过
	if incomingSize > 0 && existingSize == incomingSize {
		return ConflictResolution{
			TargetFileName: cleanName,
			ShouldSkip:     true,
			IsRenamed:      false,
		}
	}

	// 3. 存在同名但大小不同（或大小未知） -> 必须自动重命名消解冲突，防止静默覆盖
	ext := filepath.Ext(cleanName)
	base := strings.TrimSuffix(cleanName, ext)

	startIndex := 1
	if match := indexedNameRegex.FindStringSubmatch(base); match != nil {
		base = match[1]
		if num, err := strconv.Atoi(match[2]); err == nil && num >= 1 {
			startIndex = num + 1
		}
	}

	for i := startIndex; i <= 9999; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", base, i, ext)
		candLower := strings.ToLower(candidate)

		candSize, exists := exactMap[candidate]
		if !exists {
			candSize, exists = lowerMap[candLower]
		}

		if !exists {
			return ConflictResolution{
				TargetFileName: candidate,
				ShouldSkip:     false,
				IsRenamed:      true,
			}
		}

		// 如果候选名已经存在，但大小恰好吻合，说明之前已经作为该序号上传过
		if incomingSize > 0 && candSize == incomingSize {
			return ConflictResolution{
				TargetFileName: candidate,
				ShouldSkip:     true,
				IsRenamed:      candidate != cleanName,
			}
		}
	}

	// 极端边界（超过9999重名）：追加毫秒级时间戳兜底
	timestampCandidate := fmt.Sprintf("%s_%d%s", base, time.Now().UnixMilli(), ext)
	return ConflictResolution{
		TargetFileName: timestampCandidate,
		ShouldSkip:     false,
		IsRenamed:      true,
	}
}
