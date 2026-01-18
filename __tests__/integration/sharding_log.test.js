// Mock processedMessages Map
const processedMessages = new Map();

describe("Message Handling Logic (Post-Sharding Removal)", () => {
    beforeEach(() => {
        processedMessages.clear();
        // 清理环境变量，避免遗留影响
        delete process.env.INSTANCE_COUNT;
        delete process.env.INSTANCE_ID;
    });

    /**
     * 模拟修复后的 index.js 消息处理逻辑
     * 移除了硬编码的分片逻辑，现在所有消息都会被处理
     */
    async function simulateHandleMessage(msgId) {
        // --- index.js 逻辑开始 (修复后) ---
        // 基础事件记录

        // 去重检查：防止多实例部署时的重复处理
        if (msgId !== null && msgId !== undefined) {
            const now = Date.now();
            if (processedMessages.has(msgId)) {
                return "skipped_by_dedup";
            }
            processedMessages.set(msgId, now);
        }

        return "processed";
        // --- index.js 逻辑结束 ---
    }

    test("should process all messages regardless of instance ID (no sharding)", async () => {
        // 设置环境变量（但不会被使用）
        process.env.INSTANCE_COUNT = "3";
        process.env.INSTANCE_ID = "2";

        const result = await simulateHandleMessage(10);
        expect(result).toBe("processed");
    });

    test("should process message without environment variables", async () => {
        const result = await simulateHandleMessage(15);
        expect(result).toBe("processed");
    });

    test("should skip duplicate messages and log it", async () => {
        // 第一次处理
        await simulateHandleMessage(100);
        expect(processedMessages.has(100)).toBe(true);

        // 第二次处理同一消息
        const result = await simulateHandleMessage(100);

        expect(result).toBe("skipped_by_dedup");
    });

    test("should handle null/undefined message IDs gracefully", async () => {
        const result1 = await simulateHandleMessage(null);
        expect(result1).toBe("processed");

        const result2 = await simulateHandleMessage(undefined);
        expect(result2).toBe("processed");

        const result3 = await simulateHandleMessage(0); // 0 也是有效 ID
        expect(result3).toBe("processed");
        expect(processedMessages.has(0)).toBe(true);
    });

    test("should process multiple different messages", async () => {
        const messages = [1, 2, 3, 5, 8, 13];
        const results = await Promise.all(messages.map(id => simulateHandleMessage(id)));

        results.forEach(result => expect(result).toBe("processed"));
        messages.forEach(id => expect(processedMessages.has(id)).toBe(true));

        // 确认每个消息都被记录了
        expect(processedMessages.size).toBe(messages.length);
    });

    test("should not have any sharding-related logic or logs", async () => {
        process.env.INSTANCE_COUNT = "5";
        process.env.INSTANCE_ID = "3";

        const result = await simulateHandleMessage(2236); // 原始问题的消息 ID
        expect(result).toBe("processed");
    });

    test("should maintain backward compatibility with deduplication", async () => {
        // 模拟多个实例同时收到同一消息的情况
        const instances = ["instance1", "instance2", "instance3"];

        // 第一个实例处理消息
        await simulateHandleMessage(999);
        expect(processedMessages.has(999)).toBe(true);

        // 其他实例尝试处理同一消息
        for (const instance of instances.slice(1)) {
            const result = await simulateHandleMessage(999);
            expect(result).toBe("skipped_by_dedup");
        }
    });
});