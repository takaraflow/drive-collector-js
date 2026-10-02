import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStateMachine } from "../../src/domain/task-state-machine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = path.resolve(
    __dirname,
    "../../cmd/collector/testdata/task_state_vectors.json"
);

/**
 * 跨语言契约护栏。
 *
 * 向量由 JS 权威实现机器导出(见 package.json `test:vectors`)。Go 侧
 * `cmd/collector/internal/contract/task_state_test.go` 跑同一份文件。
 *
 * 本文件的价值:有人改了 JS 侧状态机却忘了重生成向量时,这里会红。
 * 反过来 Go 侧漂移也会被 Go 那边的测试抓到。两边必须同时变红才算真同步。
 */
describe("task state machine 跨语言契约", () => {
    const vectors = JSON.parse(fs.readFileSync(VECTORS, "utf8"));

    it("向量文件应覆盖全部 (status × event|status) 组合", () => {
        // 7 个状态 × (11 个事件 + 7 个状态) = 126
        expect(vectors.length).toBe(126);
    });

    it("JS 实现应与向量逐条一致", () => {
        const drift = [];
        for (const v of vectors) {
            let res;
            try {
                res = TaskStateMachine.resolveTransition(v.from, v.input);
            } catch (e) {
                if (!v.error) {
                    drift.push(`${v.from}+${v.input}: 期望成功却抛错 ${e.code}`);
                }
                continue;
            }
            if (v.error) {
                drift.push(`${v.from}+${v.input}: 期望错误 ${v.error} 却成功`);
                continue;
            }
            if (res.allowed !== v.allowed ||
                res.event !== v.event ||
                res.toStatus !== v.toStatus ||
                res.idempotent !== v.idempotent ||
                res.reason !== v.reason) {
                drift.push(
                    `${v.from}+${v.input}: JS=${JSON.stringify({
                        allowed: res.allowed, event: res.event,
                        toStatus: res.toStatus, idempotent: res.idempotent, reason: res.reason
                    })} 向量=${JSON.stringify(v)}`
                );
            }
        }
        expect(drift, `状态机已漂移,需重跑 npm run test:vectors\n${drift.join("\n")}`).toEqual([]);
    });
});