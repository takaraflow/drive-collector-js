/**
 * 影子比对契约(JS 侧)。
 *
 * 与 Go 的 cmd/collector/internal/shadowfingerprint/ 逐字对应,由
 * testdata/shadow_fingerprint_vectors.json 跨语言向量锁死。
 * 改任何一侧都必须重跑 `npm run test:vectors:shadow-fingerprint`,
 * 否则对端测试会红。
 *
 * ## 为什么用 TL TypeID 而不是类名
 *
 * 类名不可靠,实测踩过两个坑:
 *   - gramjs 的类是 Proxy 生成的,`u.constructor.name` 恒为
 *     "VirtualClass",拿不到真实类型
 *   - gotd 的 `TypeName()` 返回小写开头的 "updateNewMessage",
 *     与 gramjs 的 "UpdateNewMessage" 大小写对不上
 *
 * 而 CONSTRUCTOR_ID / TypeID 是 MTProto 协议层的稳定标识,两个库
 * 对同一个类型给出同一个数字(UpdateNewMessage 都是 0x1f2b0afd)。
 * 类名会随库版本变,TypeID 不会。
 *
 * ## 为什么指纹只用「单条 update 级别」的维度
 *
 * gramjs 的 addEventHandler 逐条回调,gotd 的 UpdateHandler 收批次。
 * 两边数据形状不同,批次级别的维度(一次收到几条)Node 侧算不出来 ——
 * 拿它做比对,diff 全是噪声。
 *
 * 刻意不记录消息内容:比对的是「看到了什么」,不是「内容是什么」。
 */

/**
 * 取 update 的 TL TypeID(十六进制字符串)。
 *
 * 优先 CONSTRUCTOR_ID;取不到就返回空串,让指纹显式体现「未知类型」
 * 而不是伪装成某个具体类型。
 */
export function extractTypeId(update) {
    const id = update?.CONSTRUCTOR_ID;
    if (typeof id === 'number') {
        return id.toString(16).padStart(8, '0');
    }
    if (typeof id === 'bigint') {
        return id.toString(16).padStart(8, '0');
    }
    return '';
}

/**
 * 生成指纹。
 * @param {{typeId?: string, hasMedia?: boolean, textLen?: number, groupId?: any}} o
 * @returns {string}
 */
export function computeFingerprint(o = {}) {
    const typeId = String(o.typeId ?? '');
    const textLen = normalizeTextLen(o.textLen);
    const groupId = o.groupId === undefined || o.groupId === null
        ? ""
        : String(o.groupId);
    return `t=${typeId}|media=${Boolean(o.hasMedia)}|text=${textLen}|gid=${groupId}`;
}

/** 把负数/非法长度归零 —— gramjs 的空消息可能给出 -1。 */
export function normalizeTextLen(n) {
    const v = Number(n) || 0;
    return v < 0 ? 0 : Math.trunc(v);
}