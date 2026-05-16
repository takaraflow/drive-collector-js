// Mock services/d1.js
const mockD1 = {
    run: vi.fn(),
    fetchOne: vi.fn(),
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
    getKeys: vi.fn().mockResolvedValue([]),
    listKeys: vi.fn().mockResolvedValue([])
};
vi.mock("../../src/services/CacheService.js", () => ({
    cache: mockCache
}));

vi.mock("../../src/services/ConsistentCache.js", () => ({
    consistentCache: {
        set: vi.fn().mockResolvedValue(true),
        get: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue(true)
    }
}));

vi.mock("../../src/services/StateSynchronizer.js", () => ({
    stateSynchronizer: {
        updateTaskState: vi.fn().mockResolvedValue(true),
        getTaskState: vi.fn().mockResolvedValue(null),
        clearTaskState: vi.fn().mockResolvedValue(true)
    }
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
        mockD1.run.mockResolvedValue({ changes: 1 });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("should retry to queued through D1 and cache-derived state", async () => {
        mockD1.fetchOne.mockResolvedValueOnce({ id: "task1", status: "failed" });

        await TaskRepository.updateStatus("task1", "queued");

        expect(TaskRepository.pendingUpdates.has("task1")).toBe(false);
        expect(d1.run).toHaveBeenCalled();
        expect(cache.set).toHaveBeenCalledWith(
            "task_status:task1",
            expect.objectContaining({ status: "queued" }),
            300
        );
    });

    it("should update D1 and cache for downloading", async () => {
        mockD1.fetchOne.mockResolvedValueOnce({ id: "task1", status: "queued" });

        await TaskRepository.updateStatus("task1", "downloading");

        expect(TaskRepository.pendingUpdates.has("task1")).toBe(false);
        expect(cache.set).toHaveBeenCalledWith(
            "task_status:task1",
            expect.objectContaining({ status: "downloading" }),
            300
        );
        expect(d1.run).toHaveBeenCalled();
    });

    it("should update D1 and cache for uploading", async () => {
        mockD1.fetchOne.mockResolvedValueOnce({ id: "task2", status: "downloaded" });

        await TaskRepository.updateStatus("task2", "uploading");

        expect(TaskRepository.pendingUpdates.has("task2")).toBe(false);
        expect(cache.set).toHaveBeenCalledWith(
            "task_status:task2",
            expect.objectContaining({ status: "uploading" }),
            300
        );
    });

    it("should immediately write critical status updates (completed)", async () => {
        mockD1.fetchOne.mockResolvedValueOnce({ id: "task1", status: "uploading" });

        await TaskRepository.updateStatus("task1", "completed");

        expect(TaskRepository.pendingUpdates.has("task1")).toBe(false);
        expect(d1.run).toHaveBeenCalled();
        expect(cache.delete).toHaveBeenCalledWith("task_status:task1");
    });

    it("should immediately write critical status updates (failed)", async () => {
        mockD1.fetchOne.mockResolvedValueOnce({ id: "task1", status: "downloading" });
        await TaskRepository.updateStatus("task1", "failed");
        expect(TaskRepository.pendingUpdates.has("task1")).toBe(false);
        expect(d1.run).toHaveBeenCalled();
    });

    it("should immediately write critical status updates (cancelled)", async () => {
        mockD1.fetchOne.mockResolvedValueOnce({ id: "task1", status: "queued" });
        await TaskRepository.updateStatus("task1", "cancelled");
        expect(TaskRepository.pendingUpdates.has("task1")).toBe(false);
        expect(d1.run).toHaveBeenCalled();
    });

    it("should flush pending updates for non-important statuses", async () => {
        TaskRepository.pendingUpdates.set("task1", { taskId: "task1", status: "queued", timestamp: Date.now() });
        TaskRepository.pendingUpdates.set("task2", { taskId: "task2", status: "queued", timestamp: Date.now() });
        mockD1.fetchOne
            .mockResolvedValueOnce({ id: "task1", status: "failed" })
            .mockResolvedValueOnce({ id: "task2", status: "failed" });

        expect(TaskRepository.pendingUpdates.size).toBe(2);

        // Trigger flush
        await TaskRepository.flushUpdates();

        expect(d1.run).toHaveBeenCalledTimes(2);
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

    it("should keep explicit pending update timestamps until flush", async () => {
        TaskRepository.pendingUpdates.set("task1", { taskId: "task1", status: "queued", timestamp: Date.now() });

        const update = TaskRepository.pendingUpdates.get("task1");
        expect(update).toHaveProperty("timestamp");
        expect(typeof update.timestamp).toBe("number");
    });

    it("should not treat derived cache failure as canonical state loss", async () => {
        mockD1.fetchOne.mockResolvedValueOnce({ id: "task1", status: "queued" });
        mockCache.set.mockRejectedValueOnce(new Error("Redis connection failed"));

        await TaskRepository.updateStatus("task1", "downloading");

        expect(d1.run).toHaveBeenCalled();
        expect(TaskRepository.pendingUpdates.has("task1")).toBe(false);
    });
});
