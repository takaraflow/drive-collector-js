// Mock services/d1.js
const mockD1 = {
    run: vi.fn(),
    batch: vi.fn().mockImplementation(async (statements) => {
        return statements.map(() => ({ success: true, result: {} }));
    })
};
vi.mock("../../src/services/d1.js", () => ({
    d1: mockD1
}));

// Mock services/CacheService.js
const mockCache = {
    set: vi.fn().mockResolvedValue(true),
    get: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(true),
    getKeys: vi.fn().mockResolvedValue([])
};
vi.mock("../../src/services/CacheService.js", () => ({
    cache: mockCache
}));

// Import after mocking
const { TaskRepository } = await import("../../src/repositories/TaskRepository.js");
const { d1 } = await import("../../src/services/d1.js");
const { cache } = await import("../../src/services/CacheService.js");

describe("TaskRepository Cache", () => {
    beforeEach(() => {
        TaskRepository.pendingUpdates.clear();
        if (TaskRepository.flushTimer) {
            clearInterval(TaskRepository.flushTimer);
            TaskRepository.flushTimer = null;
        }
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("should buffer non-critical status updates (queued)", async () => {
        await TaskRepository.updateStatus("task1", "queued");
        expect(TaskRepository.pendingUpdates.has("task1")).toBe(true);
        expect(d1.run).not.toHaveBeenCalled();
        expect(cache.set).not.toHaveBeenCalled();
    });

    it("should use Redis for important status updates (downloading)", async () => {
        await TaskRepository.updateStatus("task1", "downloading");
        expect(TaskRepository.pendingUpdates.has("task1")).toBe(false);
        expect(cache.set).toHaveBeenCalledWith(
            "task_status:task1",
            expect.objectContaining({ status: "downloading" }),
            300
        );
        expect(d1.run).not.toHaveBeenCalled();
    });

    it("should use Redis for important status updates (uploading)", async () => {
        await TaskRepository.updateStatus("task2", "uploading");
        expect(TaskRepository.pendingUpdates.has("task2")).toBe(false);
        expect(cache.set).toHaveBeenCalledWith(
            "task_status:task2",
            expect.objectContaining({ status: "uploading" }),
            300
        );
    });

    it("should immediately write critical status updates (completed)", async () => {
        await TaskRepository.updateStatus("task1", "completed");
        expect(TaskRepository.pendingUpdates.has("task1")).toBe(false);
        expect(d1.run).toHaveBeenCalled();
        expect(cache.delete).toHaveBeenCalledWith("task_status:task1");
    });

    it("should immediately write critical status updates (failed)", async () => {
        await TaskRepository.updateStatus("task1", "failed");
        expect(TaskRepository.pendingUpdates.has("task1")).toBe(false);
        expect(d1.run).toHaveBeenCalled();
    });

    it("should immediately write critical status updates (cancelled)", async () => {
        await TaskRepository.updateStatus("task1", "cancelled");
        expect(TaskRepository.pendingUpdates.has("task1")).toBe(false);
        expect(d1.run).toHaveBeenCalled();
    });

    it("should flush pending updates for non-important statuses", async () => {
        await TaskRepository.updateStatus("task1", "queued");
        await TaskRepository.updateStatus("task2", "queued");

        expect(TaskRepository.pendingUpdates.size).toBe(2);

        // Trigger flush
        await TaskRepository.flushUpdates();

        expect(d1.batch).toHaveBeenCalled();
        expect(TaskRepository.pendingUpdates.size).toBe(0);
    });

    it("should cleanup expired pending updates", async () => {
        const now = Date.now();
        const expiredUpdate = { taskId: "expired", status: "queued", timestamp: now - 31 * 60 * 1000 };
        const validUpdate = { taskId: "valid", status: "queued", timestamp: now - 10 * 60 * 1000 };

        TaskRepository.pendingUpdates.set("expired", expiredUpdate);
        TaskRepository.pendingUpdates.set("valid", validUpdate);

        // Call cleanup
        TaskRepository.cleanupExpiredUpdates();

        // Check results
        expect(TaskRepository.pendingUpdates.has("expired")).toBe(false);
        expect(TaskRepository.pendingUpdates.has("valid")).toBe(true);
        expect(TaskRepository.pendingUpdates.size).toBe(1);
    });

    it("should handle empty pendingUpdates cleanup", () => {
        TaskRepository.pendingUpdates.clear();

        // Call cleanup
        expect(() => TaskRepository.cleanupExpiredUpdates()).not.toThrow();
    });

    it("should add timestamp to pending updates for non-important statuses", async () => {
        await TaskRepository.updateStatus("task1", "queued");

        const update = TaskRepository.pendingUpdates.get("task1");
        expect(update).toHaveProperty("timestamp");
        expect(typeof update.timestamp).toBe("number");
    });

    it("should handle Redis failure gracefully and fallback to memory buffer", async () => {
        mockCache.set.mockRejectedValueOnce(new Error("Redis connection failed"));

        await TaskRepository.updateStatus("task1", "downloading");

        // Should fallback to memory buffer
        expect(TaskRepository.pendingUpdates.has("task1")).toBe(true);
    });
});
