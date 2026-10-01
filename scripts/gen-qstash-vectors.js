import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT } from "jose";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../testdata/qstash_vectors.json");

const KEY = "test-signing-key-12345";
const URL_UNDER_TEST = "https://lb.example.com/api/v2/tasks/download-tasks";

const BODY = JSON.stringify({
    taskId: "task-abc-123",
    type: "download",
    meta: { triggerSource: "telegram", instanceId: "inst-1", timestamp: 1790862775 },
});

const bodyHash = createHash("sha256").update(BODY).digest("base64url");

async function sign(claims, { key = KEY, issuer = "Upstash" } = {}) {
    return await new SignJWT(claims)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer(issuer)
        .setIssuedAt()
        .sign(new TextEncoder().encode(key));
}

/**
 * 生成 QStash 验签向量。
 *
 * 用 jose(和 @upstash/qstash 内部同一个库)签名,Go 侧用标准库验。
 * 这样测的不是「我自己和自己一致」,而是真正的跨库互操作 ——
 * 这正是无缝替换线上服务时唯一需要保证的东西。
 */
const valid = await sign({ sub: URL_UNDER_TEST, body: bodyHash });

const vectors = [
    { name: "valid", signature: valid, body: BODY, url: URL_UNDER_TEST, expect: "ok" },
    {
        name: "body-tampered",
        signature: valid,
        body: JSON.stringify({ taskId: "evil" }),
        url: URL_UNDER_TEST,
        expect: "body-hash",
    },
    {
        name: "url-mismatch",
        signature: valid,
        body: BODY,
        url: "https://evil.com/api/v2/tasks/download-tasks",
        expect: "subject",
    },
    {
        // 必须真的用攻击者的 key 签名,否则测的是「用正确 key 签的签名」
        // ——那种情况本来就该通过,测不出任何东西。
        name: "signed-with-wrong-key",
        signature: await sign({ sub: URL_UNDER_TEST, body: bodyHash }, { key: "attacker-key" }),
        body: BODY,
        url: URL_UNDER_TEST,
        expect: "signature",
    },
    {
        name: "wrong-issuer",
        signature: await sign({ sub: URL_UNDER_TEST, body: bodyHash }, { issuer: "NotUpstash" }),
        body: BODY,
        url: URL_UNDER_TEST,
        expect: "issuer",
    },
    {
        name: "malformed",
        signature: "not-a-jwt",
        body: BODY,
        url: URL_UNDER_TEST,
        expect: "malformed",
    },
    {
        name: "empty-signature",
        signature: "",
        body: BODY,
        url: URL_UNDER_TEST,
        expect: "malformed",
    },
];

// 补一份「用另一个 key 签的合法签名」,确认 Receiver 会依次尝试 current/next。
const nextKey = "next-signing-key-67890";
const nextKeySig = await new SignJWT({ sub: URL_UNDER_TEST, body: bodyHash })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("Upstash")
    .setIssuedAt()
    .sign(new TextEncoder().encode(nextKey));
vectors.push({
    name: "signed-with-next-key",
    signature: nextKeySig,
    body: BODY,
    url: URL_UNDER_TEST,
    expect: "ok",
    nextKey,
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ key: KEY, vectors }, null, 1) + "\n");
console.log(`已导出 ${vectors.length} 条 QStash 验签向量 → ${path.relative(process.cwd(), OUT)}`);