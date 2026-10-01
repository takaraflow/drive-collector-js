#!/usr/bin/env node
/**
 * 从 JS 权威实现导出跨语言测试向量。
 *
 * Go 侧 cmd/collector/internal/contract/ 跑同一份文件,任何一侧语义
 * 漂移都会让对端测试变红。改了 src/domain/task-state-machine.js 后
 * 必须重跑 `npm run test:vectors`,否则 __tests__/architecture/
 * task-state-contract.test.js 会红并提示你。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    TaskStateMachine,
    TASK_STATUSES,
    TASK_TRANSITIONS,
} from "../src/domain/task-state-machine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, "../cmd/collector/testdata/task_state_vectors.json");

const statuses = Object.values(TASK_STATUSES);
const events = Object.keys(TASK_TRANSITIONS);

const cases = [];
for (const from of statuses) {
    // 事件名和目标状态名都能传(JS 侧 resolveTransition 两者皆收),一起覆盖。
    for (const input of [...events, ...statuses]) {
        let r;
        try {
            r = TaskStateMachine.resolveTransition(from, input);
        } catch (e) {
            cases.push({ from, input, error: e.code });
            continue;
        }
        cases.push({
            from,
            input,
            allowed: r.allowed,
            event: r.event,
            toStatus: r.toStatus,
            idempotent: r.idempotent,
            reason: r.reason,
        });
    }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(cases, null, 1) + "\n");
console.log(`已导出 ${cases.length} 条向量 → ${path.relative(process.cwd(), OUT)}`);