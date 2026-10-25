//go:build !linux

package storageguard

import "math"

func statfsAvailableBytes(path string) (uint64, error) {
	// 非 Linux 平台降级放行（或由各平台专用系统调用扩展）
	return math.MaxInt64, nil
}
