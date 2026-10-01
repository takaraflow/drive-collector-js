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
	"crypto/sha1"
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

// Telethon 兼容格式的长度。
//
// gramjs 判的是 base64【字符串】长度(StringSession.js: `session.length == 352`),
// 换成解码后的字节数是 263。两个数都要比 —— 只比一个会让守卫
// 永不触发,然后按 gramjs 格式解出一堆垃圾 auth_key,
// 不报错、直接拿错 key 去连。
const (
	telethonSessionStrLen  = 352 // gramjs 用的判据:base64 串长
	telethonSessionByteLen = 263 // 同一格式的解码后字节数
)

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

	if len(raw) == telethonSessionByteLen || len(s) == telethonSessionStrLen {
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

	// 不做 gramjs 那个 addrLen > 100 的 IPv6 回退分支。
	//
	// gramjs 的 save()(StringSession.js)无条件写
	// `addressLengthBuffer.writeInt16BE(addressBuffer.length)`,
	// 而 IPv6 字面量最长 39 字符 —— 它自己产出的 session 永远进不了
	// 那个分支。那个分支只在 load() 侧存在,用来读别的库(Telethon 系)
	// 写出的 session。
	//
	// 实现了它反而更危险:gramjs 那边是 `reader.offset -= 2` 后读 16 字节
	// (即 raw[1:17]),照抄错了会偏移两字节解出垃圾;而且 net.IP.String()
	// 会把 IPv4-mapped 地址压成点分十进制,与 gramjs 的
	// `.match(/.{1,4}/g).join(":")` 输出不同(::ffff:7f00:1 vs 127.0.0.1)。
	// 超长 addrLen 一律当损坏拒掉 —— 静默解出错的 authKey 比报错糟得多。
	if len(raw) < pos+addrLen+2+256 {
		return nil, fmt.Errorf("%w: addrLen %d overruns buffer", ErrTooShort, addrLen)
	}
	out.ServerAddr = string(raw[pos : pos+addrLen])
	pos += addrLen

	out.Port = int(binary.BigEndian.Uint16(raw[pos : pos+2]))
	pos += 2

	key := raw[pos : pos+256]
	if len(key) != 256 {
		return nil, fmt.Errorf("%w: got %d", ErrAuthKeySize, len(key))
	}
	out.AuthKey = append([]byte(nil), key...)

	return out, nil
}

// AuthKeyID 按 MTProto 定义算 auth_key_id = SHA1(auth_key)[12:20]。
//
// 必填,不是可选优化:gotd 的 telegram/session.go 在恢复连接时会
// `copy(key.ID[:], data.AuthKeyID)` 后校验 `key.Value.ID() != key.ID`,
// 不等就返回 "corrupted key" 直接失败。留空 = 全零 ID ≠ 真实 ID,
// 影子模式 100% 连不上。
func (s *Session) AuthKeyID() []byte {
	sum := sha1.Sum(s.AuthKey)
	out := make([]byte, 8)
	copy(out, sum[12:])
	return out
}

// Addr 组合成 host:port,gotd 侧直接可用。
func (s *Session) Addr() string {
	return net.JoinHostPort(s.ServerAddr, strconv.Itoa(s.Port))
}
