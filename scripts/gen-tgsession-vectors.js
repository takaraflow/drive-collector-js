import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
// gramjs 的 sessions 子模块之间有循环依赖,直接 import 子文件会炸
// ("Class extends value undefined")。走包入口 + createRequire 才稳 ——
// 这也是生产代码 src/services/telegram.js 的用法。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { StringSession } = require("telegram/sessions/index.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../testdata/tgsession_vectors.json");

/**
 * 生成 StringSession 解析向量。
 *
 * 用 gramjs 自己的 StringSession 构造,再让 Go 侧解回来 —— 测的是
 * 真正的跨库格式兼容,不是「我按注释理解得对不对」。
 * authKey 用固定种子,保证向量可复现。
 */
function buildSession(dcId, addr, port, seed) {
    const key = Buffer.alloc(256);
    // 从 seed 确定性填充,便于 Go 侧逐字节校验
    let h = crypto.createHash("sha256").update(seed).digest();
    for (let i = 0; i < 256; i++) {
        key[i] = h[i % 32];
        if (i % 32 === 31 && i < 255) {
            h = crypto.createHash("sha256").update(h).digest();
        }
    }

    const addrBuf = Buffer.from(addr);
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeInt16BE(addrBuf.length, 0);
    const portBuf = Buffer.alloc(2);
    portBuf.writeInt16BE(port, 0);

    const s = "1" + Buffer.concat([
        Buffer.from([dcId]),
        lenBuf,
        addrBuf,
        portBuf,
        key,
    ]).toString("base64");

    return { s, key: key.toString("base64") };
}

const cases = [
    { name: "dc2-default", ...buildSession(2, "149.154.175.116", 80, "dc2") },
    { name: "dc1-long-addr", ...buildSession(1, "149.154.167.40", 443, "dc1") },
    { name: "dc4-ipv6", ...buildSession(4, "149.154.175.117", 443, "dc4") },
    { name: "custom-dc", ...buildSession(5, "10.0.0.1", 80, "custom") },
];

// 畸形输入:Go 侧必须明确拒绝,不能静默解出垃圾
const malformed = [
    { name: "empty", s: "" },
    { name: "wrong-version", s: "2" + Buffer.alloc(300).toString("base64") },
    { name: "not-base64", s: "1!!!not-base64!!!" },
    { name: "too-short", s: "1" + Buffer.alloc(50).toString("base64") },
    { name: "no-version-prefix", s: Buffer.alloc(300).toString("base64") },
];

// gramjs 自己能否往返:确认我们造的数据和它的解析逻辑一致
for (const c of cases) {
    const sess = new StringSession(c.s);
    if (sess.dcId !== Number(c.name.match(/dc(\d)/)?.[1] || 0) && c.name !== "custom-dc") {
        console.warn(`注意: ${c.name} gramjs 解析出 dcId=${sess.dcId}`);
    }
    await sess.load();
    const parsed = sess.authKey?.getKey();
    if (!parsed || !parsed.equals(Buffer.from(c.key, "base64"))) {
        throw new Error(`${c.name}: gramjs 无法还原 authKey —— 向量构造有误`);
    }
    if (sess.save() !== c.s) {
        throw new Error(`${c.name}: gramjs save() 往返不一致`);
    }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
    OUT,
    JSON.stringify({ cases, malformed }, null, 1) + "\n"
);
console.log(`已导出 ${cases.length} 条合法 + ${malformed.length} 条畸形向量 → ${path.relative(process.cwd(), OUT)}`);