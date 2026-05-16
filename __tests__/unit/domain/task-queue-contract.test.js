import { describe, expect, test } from "vitest";
import {
    buildDownloadQueueMessage,
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
});
