// Go 1.25 是 gotd/td 的最低要求(见其 go.mod)。定在 1.24 会让 CI
// 反复触发 toolchain 下载,定 1.25 起步一次到位。
module github.com/youngsx/drive-collector

go 1.25