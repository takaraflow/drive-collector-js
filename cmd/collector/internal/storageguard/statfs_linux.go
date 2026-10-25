//go:build linux

package storageguard

import (
	"syscall"
)

func statfsAvailableBytes(path string) (uint64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	// Bavail 是非特权用户可用的空闲块数
	// 块大小在某些架构上是 int32 / int64，统一转为 uint64
	return stat.Bavail * uint64(stat.Bsize), nil
}
