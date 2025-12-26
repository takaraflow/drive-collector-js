import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// Mock processedMessages Map
const processedMessages = new Map();

// Mock console.log
const logSpy = jest.fn();
const originalLog = console.log;

describe("Sharding and Deduplication Logic (Simulated)", () => {
    beforeEach(() => {
        processedMessages.clear();
        logSpy.mockClear();
        console.log = logSpy;
        delete process.env.INSTANCE_COUNT;
        delete process.env.INSTANCE_ID;
    });

    /**
     * 模拟 index.js 中的消息处理逻辑
     */
    async function simulateHandleMessage(msgId, instanceCount, instanceId) {
        if (instanceCount && instanceId) {
            process.env.INSTANCE_COUNT = instanceCount.toString();
            process.env.INSTANCE_ID = instanceId.toString();
        }

        // --- index.js 逻辑开始 ---
        // 基础事件记录
        console.log(`📩 收到新事件: UpdateNewMessage`);

        if (msgId && process.env.INSTANCE_COUNT && process.env.INSTANCE_ID) {
            const count = parseInt(process.env.INSTANCE_COUNT);
            const id = parseInt(process.env.INSTANCE_ID);
            if (msgId % count !== (id - 1) % count) {
                return "skipped_by_sharding";
            }
        }

        if (msgId) {
            const now = Date.now();
            if (processedMessages.has(msgId)) {
                console.log(`♻️ 跳过重复消息 ${msgId} (已由本实例或其他分片处理)`);
                return "skipped_by_dedup";
            }
            processedMessages.set(msgId, now);
        }
        
        return "processed";
        // --- index.js 逻辑结束 ---
    }

    test("should process message if it belongs to this instance shard", async () => {
        const result = await simulateHandleMessage(10, 2, 1); // 10 % 2 = 0, instance 1 handles (1-1=0)
        expect(result).toBe("processed");
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("📩 收到新事件"));
    });

    test("should skip message if it belongs to another instance shard", async () => {
        const result = await simulateHandleMessage(11, 2, 1); // 11 % 2 = 1, instance 1 skips
        expect(result).toBe("skipped_by_sharding");
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("📩 收到新事件"));
        expect(processedMessages.has(11)).toBe(false);
    });

    test("should skip duplicate messages and log it", async () => {
        await simulateHandleMessage(100, 1, 1);
        const result = await simulateHandleMessage(100, 1, 1);
        
        expect(result).toBe("skipped_by_dedup");
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("♻️ 跳过重复消息 100"));
    });

    test("should not log sharding skip (as per implementation)", async () => {
        const result = await simulateHandleMessage(11, 2, 1);
        expect(result).toBe("skipped_by_sharding");
        // 确认没有 sharding 的日志（因为代码中被注释掉了）
        expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("[Sharding]"));
    });

    afterAll(() => {
        console.log = originalLog;
    });
});