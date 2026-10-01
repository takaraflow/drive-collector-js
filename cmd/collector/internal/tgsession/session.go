// Package tgsession 解析 gramjs StringSession 格式。
//
// 影子模式下 Go 侧必须复用 Node 已登录的 session —— 重新登录会触发
// AUTH_KEY_DUPLICATED,并把正在服务的 Node 实例踢下线(记忆里的
// PR#445/447 踩过这个坑)。
//
// 布局(由 src 的 telegram/sessions/StringSession.js save() 反推并实测):
//
//	"1" + base64(
//	    dcId      uint8
//	    addrLen   int16 BE
//	    addr      addrLen 字节(IPv4 点分十进制 / IPv6 hex)
//	    port      int16 BE
//	    authKey   256 字节
//	)
//
// 注意:gramjs 的 Telethon 兼容分支(总长 352)没有 addrLen 字段,
// 那种 session 本项目不会产生,但解析时要能识别并明确拒绝,而不是
// 静默解出垃圾数据。
package tgsession

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
)

var (
	// ErrVersion session 串首字符不是 "1" —— gramjs 自己也这么判
	ErrVersion = errors.New("tgsession: unsupported version")
	// ErrTooShort 缓冲区不足以容纳头部字段
	ErrTooShort = errors.New("tgsession: session string too short")
	// ErrAuthKeySize authKey 不是 256 字节
	ErrAuthKeySize = errors.New("tgsession: auth key must be 256 bytes")
)

// Session 是解析后的会话状态。
type Session struct {
	DCID       int
	ServerAddr string
	Port       int
	AuthKey    []byte
}

// TelethonSessionLen 是 gramjs 判断 Telethon 兼容格式用的总长度。
// 我们的解析器不支持那种格式(没有 addrLen),但要能识别出来。
const telethonSessionLen = 352

// Parse 解析 gramjs StringSession.save() 的输出。
func Parse(s string) (*Session, error) {
	if s == "" {
		return nil, ErrTooShort
	}
	if s[0] != '1' {
		return nil, fmt.Errorf("%w: got %q", ErrVersion, s[:1])
	}

	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(s, "1"))
	if err != nil {
		return nil, fmt.Errorf("tgsession: base64: %w", err)
	}

	if len(raw) == telethonSessionLen {
		// gramjs 在这个长度下按 Telethon 格式解析(固定 4 字节 IPv4,
		// 无长度前缀)。我们不实现它 —— 与其解出错误数据,不如明说。
		return nil, errors.New("tgsession: telethon-format session not supported " +
			"(this project never produces them; refusing to guess)")
	}

	// 最小长度:1(dcId) + 2(len) + 2(port) + 256(key)
	if len(raw) < 261 {
		return nil, fmt.Errorf("%w: %d bytes", ErrTooShort, len(raw))
	}

	out := &Session{}
	out.DCID = int(raw[0])

	addrLen := int(binary.BigEndian.Uint16(raw[1:3]))
	pos := 3
	if addrLen > 100 {
		// gramjs 会对超长值回退成 IPv6 hex 编码(16 字节)。
		if len(raw) < pos+16+2+256 {
			return nil, fmt.Errorf("%w: truncated ipv6 form", ErrTooShort)
		}
		out.ServerAddr = formatIPv6(raw[pos : pos+16])
		pos += 16
	} else {
		if len(raw) < pos+addrLen+2+256 {
			return nil, fmt.Errorf("%w: addrLen %d overruns buffer", ErrTooShort, addrLen)
		}
		out.ServerAddr = string(raw[pos : pos+addrLen])
		pos += addrLen
	}

	out.Port = int(binary.BigEndian.Uint16(raw[pos : pos+2]))
	pos += 2

	key := raw[pos : pos+256]
	if len(key) != 256 {
		return nil, fmt.Errorf("%w: got %d", ErrAuthKeySize, len(key))
	}
	out.AuthKey = append([]byte(nil), key...)

	return out, nil
}

// formatIPv6 把 16 字节还原成点分十进制,与 gramjs 的
// `.match(/.{1,4}/g).join(":")` 保持一致。
func formatIPv6(b []byte) string {
	var ip net.IP = append(net.IP(nil), b...)
	return ip.String()
}

// Addr 组合成 host:port,goth 侧直接可用。
func (s *Session) Addr() string {
	return net.JoinHostPort(s.ServerAddr, strconv.Itoa(s.Port))
}