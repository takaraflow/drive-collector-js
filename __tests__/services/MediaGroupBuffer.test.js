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

  beforeEach(() => {
    vi.clearAllMocks();

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

    cache.get.mockImplementation((key) => {
      if (key === `${baseKey}:processed_messages:msg-1`) return null;
      return null;
    });

    cache.listKeys.mockImplementation((pattern) => {
      if (pattern === `${baseKey}:buffer:group-123:msg:*`) return [`${baseKey}:buffer:group-123:msg:msg-1`];
      return [];
    });

    const result = await buffer.add(message, target, userId);

    expect(result).toEqual({ added: true, reason: "buffered" });
    expect(mockLock.acquire).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledWith(
      `${baseKey}:timer:group-123`,
      expect.objectContaining({ expiresAt: expect.any(Number) }),
      expect.any(Number)
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

    cache.get.mockImplementation((key) => {
      if (key.includes(`${baseKey}:processed_messages:`)) return null;
      if (key === `${baseKey}:buffer:group-123:meta`) return { target, userId, createdAt: Date.now(), updatedAt: Date.now() };
      if (key === `${baseKey}:buffer:group-123:msg:msg-1`) return { id: "msg-1", media: { file_id: "photo1" }, groupedId: "group-123", _seq: 1 };
      if (key === `${baseKey}:buffer:group-123:msg:msg-2`) return { id: "msg-2", media: { file_id: "photo2" }, groupedId: "group-123", _seq: 2 };
      return null;
    });

    let sizeCall = 0;
    cache.listKeys.mockImplementation((pattern) => {
      if (pattern === `${baseKey}:buffer:group-123:msg:*`) {
        sizeCall += 1;
        return sizeCall === 1
          ? [`${baseKey}:buffer:group-123:msg:msg-1`]
          : [`${baseKey}:buffer:group-123:msg:msg-1`, `${baseKey}:buffer:group-123:msg:msg-2`];
      }
      if (pattern === `${baseKey}:buffer:group-123:*`) return [];
      return [];
    });

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
    const timerKey = `${baseKey}:timer:group-123`;
    const target = { id: "target-1" };
    const userId = "user-1";

    mockLock.acquire.mockResolvedValue({ success: true, version: "v1" });
    mockLock.getLockStatus.mockResolvedValue({ status: "held", owner: "test-instance", version: "v1" });

    cache.listKeys.mockImplementation((pattern) => {
      if (pattern === `${baseKey}:timer:*`) return [timerKey];
      if (pattern === `${baseKey}:processed_messages:*`) return [];
      if (pattern === `${baseKey}:buffer:group-123:msg:*`) return [`${baseKey}:buffer:group-123:msg:msg-1`];
      if (pattern === `${baseKey}:buffer:group-123:*`) return [];
      return [];
    });

    cache.get.mockImplementation((key) => {
      if (key === timerKey) return { expiresAt: Date.now() - 1000, updatedAt: Date.now(), instanceId: "test-instance" };
      if (key === `${baseKey}:buffer:group-123:meta`) return { target, userId, createdAt: Date.now(), updatedAt: Date.now() };
      if (key === `${baseKey}:buffer:group-123:msg:msg-1`) return { id: "msg-1", media: { file_id: "photo1" }, groupedId: "group-123", _seq: 1 };
      return null;
    });

    await buffer._cleanupStaleBuffers();

    expect(TaskManager.addBatchTasks).toHaveBeenCalled();
    expect(mockLock.acquire).toHaveBeenCalledWith(`${baseKey}:lock:group-123`, "test-instance");
  });

  test("should persist snapshot to persistKey", async () => {
    const target = { id: "target-1" };
    const userId = "user-1";

    cache.listKeys.mockImplementation((pattern) => {
      if (pattern === `${baseKey}:buffer:*:meta`) return [`${baseKey}:buffer:group-123:meta`];
      if (pattern === `${baseKey}:buffer:group-123:msg:*`) return [`${baseKey}:buffer:group-123:msg:msg-1`];
      return [];
    });

    cache.get.mockImplementation((key) => {
      if (key === `${baseKey}:buffer:group-123:meta`) return { target, userId, createdAt: Date.now(), updatedAt: Date.now() };
      if (key === `${baseKey}:buffer:group-123:msg:msg-1`) return { id: "msg-1", media: { file_id: "photo1" }, groupedId: "group-123", _seq: 1 };
      return null;
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

    cache.listKeys.mockImplementation((pattern) => {
      if (pattern === `${baseKey}:buffer:*:meta`) return [`${baseKey}:buffer:group-123:meta`];
      if (pattern === `${baseKey}:buffer:group-123:msg:*`) return [`${baseKey}:buffer:group-123:msg:msg-1`];
      if (pattern === `${baseKey}:buffer:group-123:*`) return [];
      return [];
    });

    cache.get.mockImplementation((key) => {
      if (key === "test-instance:media_group_buffer") return null;
      if (key === `${baseKey}:buffer:group-123:meta`) return { target, userId, createdAt: Date.now(), updatedAt: Date.now() };
      if (key === `${baseKey}:buffer:group-123:msg:msg-1`) return { id: "msg-1", media: { file_id: "photo1" }, groupedId: "group-123", _seq: 1 };
      return null;
    });

    await buffer.restore();

    expect(TaskManager.addBatchTasks).toHaveBeenCalled();
  });
});

