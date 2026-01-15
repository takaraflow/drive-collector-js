/**
 * MediaGroupBuffer.test.js
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { MediaGroupBuffer } from "../../src/services/MediaGroupBuffer.js";
import { cache } from "../../src/services/CacheService.js";
import { TaskManager } from "../../src/processor/TaskManager.js";

vi.mock("../../src/services/logger/index.js", () => ({
  logger: {
    withModule: vi.fn().mockReturnValue({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    })
  }
}));

vi.mock("../../src/services/CacheService.js", () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    listKeys: vi.fn(),
    compareAndSet: vi.fn()
  }
}));

vi.mock("../../src/services/DistributedLock.js", () => ({
  DistributedLock: class {
    constructor() {
      this.acquire = vi.fn();
      this.release = vi.fn();
      this.getLockStatus = vi.fn();
      this.getStats = vi.fn().mockResolvedValue({ total: 0, held: 0, expired: 0, local: 0 });
    }
  }
}));

vi.mock("../../src/processor/TaskManager.js", () => ({
  TaskManager: {
    addBatchTasks: vi.fn().mockResolvedValue(true)
  }
}));

describe("MediaGroupBuffer", () => {
  const baseKey = "media_group_buffer";
  let buffer;
  let mockLock;
  let store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = new Map();

    cache.get.mockImplementation(async (key) => (store.has(key) ? store.get(key) : null));
    cache.set.mockImplementation(async (key, value) => {
      store.set(key, value);
      return true;
    });
    cache.delete.mockImplementation(async (key) => {
      store.delete(key);
      return true;
    });
    cache.compareAndSet.mockImplementation(async (key, value, options = {}) => {
      const current = store.has(key) ? store.get(key) : null;

      if (options.ifNotExists && current !== null) return false;
      if ("ifEquals" in options) {
        const expected = options.ifEquals;
        if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
      }

      store.set(key, value);
      return true;
    });

    buffer = new MediaGroupBuffer({
      instanceId: "test-instance",
      bufferTimeout: 100,
      maxBatchSize: 2,
      cleanupInterval: 60_000
    });

    mockLock = buffer.distributedLock;
  });

  afterEach(() => {
    buffer.stopCleanup();
    buffer.cleanup();
  });

  test("should create instance with persist key", () => {
    expect(buffer.persistKey).toBe("test-instance:media_group_buffer");
    expect(buffer.baseKey).toBe("media_group_buffer");
  });

  test("should buffer message and set timeout timer (no lock on add)", async () => {
    const message = { id: "msg-1", media: { file_id: "photo1" }, groupedId: "group-123" };
    const target = { id: "target-1" };
    const userId = "user-1";

    store.set(`${baseKey}:processed_messages:msg-1`, null);

    const result = await buffer.add(message, target, userId);

    expect(result).toEqual({ added: true, reason: "buffered" });
    expect(mockLock.acquire).not.toHaveBeenCalled();
    expect(store.get(`${baseKey}:timer:group-123`)).toEqual(expect.objectContaining({ expiresAt: expect.any(Number) }));
    expect(store.get(`${baseKey}:buffer:group-123`)).toEqual(
      expect.objectContaining({
        target,
        userId,
        messages: expect.arrayContaining([expect.objectContaining({ id: "msg-1" })])
      })
    );
  });

  test("should flush when batch size is reached", async () => {
    const target = { id: "target-1" };
    const userId = "user-1";
    const messages = [
      { id: "msg-1", media: { file_id: "photo1" }, groupedId: "group-123" },
      { id: "msg-2", media: { file_id: "photo2" }, groupedId: "group-123" }
    ];

    mockLock.acquire.mockResolvedValue({ success: true, version: "v1" });
    mockLock.getLockStatus.mockResolvedValue({ status: "held", owner: "test-instance", version: "v1" });

    store.set(`${baseKey}:processed_messages:msg-1`, null);
    store.set(`${baseKey}:processed_messages:msg-2`, null);

    await buffer.add(messages[0], target, userId);
    const result = await buffer.add(messages[1], target, userId);

    expect(result).toEqual({ added: true, reason: "flush_triggered" });
    expect(mockLock.acquire).toHaveBeenCalledWith(`${baseKey}:lock:group-123`, "test-instance");
    expect(TaskManager.addBatchTasks).toHaveBeenCalledWith(
      target,
      expect.arrayContaining([expect.objectContaining({ id: "msg-1" }), expect.objectContaining({ id: "msg-2" })]),
      userId
    );
    expect(mockLock.release).toHaveBeenCalledWith(`${baseKey}:lock:group-123`, "test-instance");
  });

  test("should flush expired buffer during cleanup", async () => {
    const target = { id: "target-1" };
    const userId = "user-1";

    mockLock.acquire.mockResolvedValue({ success: true, version: "v1" });
    mockLock.getLockStatus.mockResolvedValue({ status: "held", owner: "test-instance", version: "v1" });

    store.set(`${baseKey}:index`, { gids: ["group-123"] });
    store.set(`${baseKey}:timer:group-123`, { expiresAt: Date.now() - 1000, updatedAt: Date.now(), instanceId: "test-instance" });
    store.set(`${baseKey}:buffer:group-123`, {
      target,
      userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: "msg-1", media: { file_id: "photo1" }, groupedId: "group-123", _seq: 1 }]
    });

    await buffer._cleanupStaleBuffers();

    expect(TaskManager.addBatchTasks).toHaveBeenCalled();
    expect(mockLock.acquire).toHaveBeenCalledWith(`${baseKey}:lock:group-123`, "test-instance");
  });

  test("should persist snapshot to persistKey", async () => {
    const target = { id: "target-1" };
    const userId = "user-1";

    store.set(`${baseKey}:index`, { gids: ["group-123"] });
    store.set(`${baseKey}:buffer:group-123`, {
      target,
      userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: "msg-1", media: { file_id: "photo1" }, groupedId: "group-123", _seq: 1 }]
    });

    await buffer.persist();

    expect(cache.set).toHaveBeenCalledWith(
      "test-instance:media_group_buffer",
      expect.objectContaining({ instanceId: "test-instance", buffers: expect.any(Array) }),
      60
    );
  });

  test("should restore by scanning cache buffers", async () => {
    const target = { id: "target-1" };
    const userId = "user-1";

    mockLock.acquire.mockResolvedValue({ success: true, version: "v1" });
    mockLock.getLockStatus.mockResolvedValue({ status: "held", owner: "test-instance", version: "v1" });
    store.set(`${baseKey}:index`, { gids: ["group-123"] });
    store.set(`${baseKey}:buffer:group-123`, {
      target,
      userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: "msg-1", media: { file_id: "photo1" }, groupedId: "group-123", _seq: 1 }]
    });

    await buffer.restore();

    expect(TaskManager.addBatchTasks).toHaveBeenCalled();
  });
});
