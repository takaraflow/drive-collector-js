import { describe, expect, test } from "vitest";
import {
    buildDownloadQueueMessage,
    buildTaskQueueIdempotencyKey,
    normalizeTaskQueueAttempt,
    parseTaskQueuePayload,
    TASK_QUEUE_TRIGGER_SOURCES,
    TASK_QUEUE_TYPES
} from "../../../src/domain/task-queue-contract.js";

describe("task queue contract", () => {
    test("should build canonical download payloads", () => {
        const payload = buildDownloadQueueMessage("task1", {
            chatId: "chat1",
            _meta: { triggerSource: TASK_QUEUE_TRIGGER_SOURCES.MANUAL_RETRY }
        }, { instanceId: "instance1", timestamp: 123 });

        expect(payload).toEqual({
            taskId: "task1",
            type: TASK_QUEUE_TYPES.DOWNLOAD,
            chatId: "chat1",
            _meta: expect.objectContaining({
                triggerSource: TASK_QUEUE_TRIGGER_SOURCES.MANUAL_RETRY,
                instanceId: "instance1",
                timestamp: 123
            })
        });
    });

    test("should parse payload metadata with defaults", () => {
        expect(parseTaskQueuePayload({ taskId: "task1", type: "upload" })).toEqual({
            taskId: "task1",
            type: "upload",
            groupId: null,
            meta: expect.objectContaining({
                triggerSource: "unknown",
                instanceId: "unknown",
                timestamp: expect.any(Number)
            })
        });
    });

    test("builds provider-safe stable idempotency keys", () => {
        const key = buildTaskQueueIdempotencyKey("download", "download", "task:123", "queued:1700000000000");

        expect(key).toMatch(/^tqv1_download_download_[A-Za-z0-9_-]+$/);
        expect(key).not.toContain(":");
    });

    test("keeps retry attempts distinct while normalizing empty attempts", () => {
        const initial = buildTaskQueueIdempotencyKey("download", "download", "task-123", normalizeTaskQueueAttempt(""));
        const retry = buildTaskQueueIdempotencyKey("download", "download", "task-123", "queued:1700000000000");

        expect(initial).not.toBe(retry);
        expect(normalizeTaskQueueAttempt("")).toBe("initial");
    });
});
