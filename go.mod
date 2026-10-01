// Go 1.25 是 gotd/td 的最低要求(见其 go.mod)。定在 1.24 会让 CI
// 反复触发 toolchain 下载,定 1.25 起步一次到位。
module github.com/youngsx/drive-collector

go 1.25

require (
	github.com/alicebob/miniredis/v2 v2.39.0
	github.com/redis/go-redis/v9 v9.22.0
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/yuin/gopher-lua v1.1.1 // indirect
	go.uber.org/atomic v1.11.0 // indirect
	golang.org/x/sys v0.30.0 // indirect
)
