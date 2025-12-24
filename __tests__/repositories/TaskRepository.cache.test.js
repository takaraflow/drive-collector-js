import { describe, it, expect, beforeEach, vi } from "vitest";
import { TaskRepository } from "../../src/repositories/TaskRepository.js";
import { d1 } from "../../src/services/d1.js";

vi.mock("../../src/services/d1.js", () => ({
    d1: {
        run: vi.fn(),
        batch: vi.fn().mockResolvedValue(true)
    }
}));

describe("TaskRepository Cache", () => {
    beforeEach(() => {
        TaskRepository.pendingUpdates.clear();
        if (TaskRepository.flushTimer) {
            clearInterval(TaskRepository.flushTimer);
            TaskRepository.flushTimer = null;
        }
        vi.useFakeTimers();
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