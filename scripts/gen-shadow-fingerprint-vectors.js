import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { computeFingerprint, extractTypeId } from "../src/domain/shadow-fingerprint.js";
const require = createRequire(import.meta.url);
const { Api } = require("telegram");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../testdata/shadow_fingerprint_vectors.json");

/**
 * 生成影子指纹向量。
 *
 * 覆盖归一化的每一个边界:Api. 前缀、空白、负数长度、null/undefined
 * groupId、数字型 groupId。Go 侧跑同一份文件。
 */
// 用真实的 gramjs update 对象构造向量 —— 手编的 TypeID 字符串测不出
// 「extractTypeId 能不能从 Proxy 类里拿到真实 ID」。
const realUpdates = [
    { name: "new-message", C: Api.UpdateNewMessage, hasMedia: false, textLen: 10 },
    { name: "new-channel-message", C: Api.UpdateNewChannelMessage, hasMedia: true, textLen: 0 },
    { name: "callback-query", C: Api.UpdateBotCallbackQuery, hasMedia: false, textLen: 5 },
    { name: "edit-message", C: Api.UpdateEditMessage, hasMedia: false, textLen: 20 },
    { name: "delete-messages", C: Api.UpdateDeleteMessages, hasMedia: false, textLen: 0 },
];

const cases = realUpdates.map((r) => ({
    name: r.name,
    hasMedia: r.hasMedia,
    textLen: r.textLen,
    groupId: r.name === "new-channel-message" ? 987654 : undefined,
    // 真实对象 → extractTypeId 必须拿得到真实 TypeID
    obj: new r.C({}),
}));

// 纯输入侧的边界(没有真实对象,或刻意给畸形值)
cases.push(
    { name: "null-group", hasMedia: false, textLen: 3, groupId: null, obj: new Api.UpdateNewMessage({}) },
    { name: "negative-textlen", hasMedia: false, textLen: -1, obj: new Api.UpdateNewMessage({}) },
    { name: "zero-textlen", hasMedia: false, textLen: 0, obj: new Api.UpdateNewMessage({}) },
    { name: "string-group", hasMedia: true, textLen: 0, groupId: "grp-123", obj: new Api.UpdateNewMessage({}) },
    { name: "no-typeid", hasMedia: false, textLen: 1, obj: {} },
    { name: "large-text", hasMedia: false, textLen: 4096, obj: new Api.UpdateNewMessage({}) },
);

const vectors = cases.map((c) => {
    const typeId = extractTypeId(c.obj);
    return {
        name: c.name,
        input: {
            typeId,
            hasMedia: c.hasMedia,
            textLen: c.textLen,
            groupId: c.groupId === undefined ? null : c.groupId,
        },
        expected: computeFingerprint({
            typeId,
            hasMedia: c.hasMedia,
            textLen: c.textLen,
            groupId: c.groupId,
        }),
    };
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(vectors, null, 1) + "\n");
console.log(`已导出 ${vectors.length} 条影子指纹向量 → ${path.relative(process.cwd(), OUT)}`);