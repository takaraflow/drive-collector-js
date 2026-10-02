import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    buildTaskQueueIdempotencyKey,
    parseTaskQueuePayload,
    normalizeTaskQueueAttempt,
} from "../src/domain/task-queue-contract.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../testdata/task_queue_vectors.json");

// 幂等键向量:topic × type × taskId × attempt
// 覆盖大小写折叠、非字母数字、连续分隔符、超长、空值 —— safeIdLabel
// 的每一处正则替换都要锁死,否则线上会重复消费。
const topics = [
    "download",
    "download-tasks",
    "Download Tasks",
    "media-batch",
    "weird!!!topic",
    "---leading-and-trailing---",
    "a".repeat(40),
    "任务_中文",
    "",
];
const types = ["download", "upload", ""];
const taskIds = [
    "task-abc-123",
    "TASK_UPPER",
    "with spaces and / slashes",
    "",
];
const attempts = [undefined, null, "", "  ", "retry-2", "initial"];

const keys = [];
for (const topic of topics) {
    for (const type of types) {
        for (const taskId of taskIds) {
            for (const attempt of attempts) {
                keys.push({
                    topic,
                    type,
                    taskId,
                    attempt: attempt === undefined ? null : attempt,
                    key: buildTaskQueueIdempotencyKey(topic, type, taskId, attempt),
                    normalized: normalizeTaskQueueAttempt(attempt),
                });
            }
        }
    }
}

// payload 解析向量:覆盖 JS 的 || 回退语义(空串也要回退)
const payloads = [
    { name: "full", body: { taskId: "t1", type: "download", groupId: "g1", _meta: { triggerSource: "qstash-v2", instanceId: "i1", timestamp: 100 } } },
    { name: "groupId-from-meta", body: { taskId: "t2", type: "upload", _meta: { groupId: "g2", triggerSource: "manual-retry", instanceId: "i2", timestamp: 200 } } },
    { name: "empty-groupId-falls-back", body: { taskId: "t3", groupId: "", _meta: { groupId: "g3" } } },
    { name: "no-meta", body: { taskId: "t4", type: "download" } },
    { name: "empty-taskId", body: { taskId: "", type: "download" } },
    { name: "meta-null", body: { taskId: "t5", _meta: null } },
    { name: "empty-object", body: {} },
];

const parsed = payloads.map((p) => {
    const r = parseTaskQueuePayload(p.body);
    return {
        name: p.name,
        taskId: r.taskId,
        type: r.type,
        groupId: r.groupId,
        triggerSource: r.meta.triggerSource,
        instanceId: r.meta.instanceId,
        // timestamp 为 0/缺失 时 JS 会填 Date.now(),Go 侧同样用调用时刻,
        // 值不固定,只断言「非零」。
        hasTimestamp: typeof r.meta.timestamp === "number" && r.meta.timestamp > 0,
    };
});

// 原始 body 一起导出,让 Go 侧解析同一份字节而不是重新拼一遍 ——
// 重新拼会掩盖 JSON 层面的差异(如 null vs 缺失)。
const rawBodies = Object.fromEntries(
    payloads.map((p) => [p.name, JSON.stringify(p.body)])
);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
    OUT,
    JSON.stringify({ keys, payloads: parsed, rawBodies }, null, 1) + "\n"
);
console.log(
    `已导出 ${keys.length} 条幂等键向量 + ${parsed.length} 条 payload 向量 → ${path.relative(process.cwd(), OUT)}`
);