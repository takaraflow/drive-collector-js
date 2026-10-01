// Package shadowfingerprint 是 JS 与 Go 共享的影子比对契约。
//
// 存在的理由:影子验证要判断「Go 看到的 update 流和 Node 是否一致」。
// 判断依据必须是两边都能算出来的量,否则 diff 全是噪声。
//
// ## 为什么用 TL TypeID 而不是类名
//
// 类名不可靠,两边都实测踩过坑:
//
//   - gramjs 的类是 Proxy 生成的,u.constructor.name 恒为 "VirtualClass"
//   - gotd 的 TypeName() 返回小写开头的 "updateNewMessage"
//
// 而 CONSTRUCTOR_ID / TypeID 是 MTProto 协议层的稳定标识:同一个类型
// 在两个库里是同一个数字(UpdateNewMessage 都是 0x1f2b0afd)。类名会随
// 库版本变,TypeID 不会。
//
// ## 为什么指纹只用「单条 update 级别」的维度
//
// gramjs 的 addEventHandler 逐条回调,gotd 的 UpdateHandler 收批次。
// 两边数据形状不同,批次级别的维度 Node 侧算不出 —— 拿它比对,diff
// 全是噪声。
//
// 格式:"t={typeIdHex}|media={bool}|text={n}|gid={groupId}"
//
// 两侧实现必须逐字一致,由 testdata/shadow_fingerprint_vectors.json
// 跨语言向量锁死。
package shadowfingerprint

import "fmt"

// Observation 是单条 update 的可观察特征。
//
// 刻意不含消息内容:比对的是「看到了什么」,不是「内容是什么」,
// 而消息内容落盘等于建隐私黑洞。
type Observation struct {
	// TypeID 是 TL 类型 ID 的十六进制字符串,如 "1f2b0afd"。
	// 取不到时留空,指纹会显式体现「未知」而不是伪装成某类型。
	TypeID string
	// HasMedia 消息是否带媒体。
	HasMedia bool
	// TextLen 消息文本长度,0 表示无文本。
	TextLen int
	// GroupID 媒体组 ID,非媒体组为空串。
	GroupID string
}

// NormalizeTypeID 统一成小写十六进制、去掉 0x 前缀。
func NormalizeTypeID(v uint32) string {
	return fmt.Sprintf("%08x", v)
}

// NormalizeTextLen 把负数长度归零 —— gramjs 的空消息可能给出 -1。
func NormalizeTextLen(n int) int {
	if n < 0 {
		return 0
	}
	return n
}

// Compute 生成指纹。
func Compute(o Observation) string {
	return fmt.Sprintf("t=%s|media=%t|text=%d|gid=%s",
		o.TypeID,
		o.HasMedia,
		NormalizeTextLen(o.TextLen),
		o.GroupID,
	)
}