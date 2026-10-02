// Go 1.25 是 gotd/td 的最低要求(见其 go.mod)。定在 1.24 会让 CI
// 反复触发 toolchain 下载,定 1.25 起步一次到位。
module github.com/youngsx/drive-collector

go 1.25.0

require (
	github.com/alicebob/miniredis/v2 v2.39.0
	github.com/gotd/log v0.1.0
	github.com/gotd/td v0.162.0
	github.com/redis/go-redis/v9 v9.22.0
)

require (
	github.com/andybalholm/brotli v1.2.1 // indirect
	github.com/cenkalti/backoff/v4 v4.3.0 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/coder/websocket v1.8.15 // indirect
	github.com/go-faster/errors v0.8.0 // indirect
	github.com/go-faster/jx v1.2.0 // indirect
	github.com/go-faster/xor v1.0.0 // indirect
	github.com/gotd/ige v0.3.0 // indirect
	github.com/gotd/neo v0.1.5 // indirect
	github.com/klauspost/compress v1.19.1 // indirect
	github.com/refraction-networking/utls v1.8.2 // indirect
	github.com/segmentio/asm v1.2.1 // indirect
	github.com/yuin/gopher-lua v1.1.1 // indirect
	go.opentelemetry.io/otel v1.44.0 // indirect
	go.opentelemetry.io/otel/trace v1.44.0 // indirect
	go.uber.org/atomic v1.11.0 // indirect
	go.uber.org/multierr v1.11.0 // indirect
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/net v0.57.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	rsc.io/qr v0.2.0 // indirect
)
