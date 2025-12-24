import { jest, describe, it, expect, beforeEach } from "@jest/globals";

// Mock services/d1.js
const mockD1 = {
    run: jest.fn(),
    // Mock return value must match the new batch implementation (array of result objects)
    batch: jest.fn().mockImplementation(async (statements) => {
        return statements.map(() => ({ success: true, result: {} }));
    })
};
jest.unstable_mockModule("../../src/services/d1.js", () => ({
    d1: mockD1
}));

// Import TaskRepository after mocking
const { TaskRepository } = await import("../../src/repositories/TaskRepository.js");
const { d1 } = await import("../../src/services/d1.js");

describe("TaskRepository Cache", () => {
    beforeEach(() => {
        TaskRepository.pendingUpdates.clear();
        if (TaskRepository.flushTimer) {
            clearInterval(TaskRepository.flushTimer);
            TaskRepository.flushTimer = null;
        }
        jest.useFakeTimers();
        jest.clearAllMocks();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    it("should buffer non-critical status updates", async () => {
        await TaskRepository.updateStatus("task1", "downloading");
        expect(TaskRepository.pendingUpdates.has("task1")).toBe(true);
        expect(d1.run).not.toHaveBeenCalled();
    });

    it("should immediately write critical status updates", async () => {
        await TaskRepository.updateStatus("task1", "completed");
        expect(TaskRepository.pendingUpdates.has("task1")).toBe(false);
        expect(d1.run).toHaveBeenCalled();
    });

    it("should flush pending updates periodically", async () => {
        await TaskRepository.updateStatus("task1", "downloading");
        await TaskRepository.updateStatus("task2", "uploading");
        
        expect(TaskRepository.pendingUpdates.size).toBe(2);
        
        // Trigger flush
        await TaskRepository.flushUpdates();
        
        expect(d1.batch).toHaveBeenCalled();
        expect(TaskRepository.pendingUpdates.size).toBe(0);
    });
});