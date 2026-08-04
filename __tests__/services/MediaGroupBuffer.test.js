/**
 * MediaGroupBuffer.test.js
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { Api } from "telegram";
import { MediaGroupBuffer } from "../../src/services/MediaGroupBuffer.js";
import { cache } from "../../src/services/CacheService.js";
import { TaskManager } from "../../src/processor/TaskManager.js";
import { client } from "../../src/services/telegram.js";
import { runMtprotoTask } from "../../src/utils/limiter.js";

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
    constructor(_cache, options = {}) {
      this.options = options;
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

vi.mock("../../src/services/telegram.js", () => ({
  client: {
    getMessages: vi.fn()
  }
}));

vi.mock("../../src/utils/limiter.js", () => ({
  runMtprotoTask: vi.fn((fn) => fn()),
  runBotTask: vi.fn(),
  runBotTaskWithRetry: vi.fn(),
  runMtprotoTaskWithRetry: vi.fn(),
  runMtprotoFileTaskWithRetry: vi.fn(),
  PRIORITY: { UI: 0, BACKGROUND: 1 }
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

    runMtprotoTask.mockImplementation(async (fn) => fn());

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
    expect(mockLock.options.keyPrefix).toBe("media_group_buffer:lock:");
  });

  test("should buffer message and set timeout timer (no lock on add)", async () => {
    const message = { id: 1001n, media: { className: "MessageMediaPhoto" }, groupedId: 9999n };
    const target = new Api.PeerUser({ userId: 500n });
    const userId = "user-1";

    const result = await buffer.add(message, target, userId);

    expect(result).toEqual({ added: true, reason: "buffered" });
    expect(mockLock.acquire).not.toHaveBeenCalled();
    expect(store.get(`${baseKey}:timer:9999`)).toEqual(expect.objectContaining({ expiresAt: expect.any(Number) }));
    const buf = store.get(`${baseKey}:buffer:9999`);
    expect(buf).toEqual(
      expect.objectContaining({
        target: { userId: "500" },
        userId,
        messages: expect.arrayContaining([expect.objectContaining({ id: "1001" })])
      })
    );
    // Stored message must NOT contain media or groupedId (BigInt-unsafe fields)
    expect(buf.messages[0].media).toBeUndefined();
    expect(buf.messages[0].groupedId).toBeUndefined();
  });

  test("should flush when batch size is reached", async () => {
    const target = new Api.PeerUser({ userId: 500n });
    const userId = "user-1";
    const messages = [
      { id: 1001n, media: { className: "MessageMediaPhoto" }, groupedId: 9999n },
      { id: 1002n, media: { className: "MessageMediaDocument" }, groupedId: 9999n }
    ];

    mockLock.acquire.mockResolvedValue({ success: true, version: "v1" });
    mockLock.getLockStatus.mockResolvedValue({ status: "held", owner: "test-instance", version: "v1" });

    // Mock client.getMessages to return full message objects with media
    client.getMessages.mockResolvedValue([
      { id: 1001, media: { className: "MessageMediaPhoto" } },
      { id: 1002, media: { className: "MessageMediaDocument" } }
    ]);

    await buffer.add(messages[0], target, userId);
    const result = await buffer.add(messages[1], target, userId);

    expect(result).toEqual({ added: true, reason: "flush_triggered" });
    expect(mockLock.acquire).toHaveBeenCalledWith("9999", "test-instance");
    expect(client.getMessages).toHaveBeenCalledWith(
      expect.any(Api.PeerUser),
      { ids: [1001n, 1002n] }
    );
    expect(TaskManager.addBatchTasks).toHaveBeenCalledWith(
      expect.any(Api.PeerUser),
      expect.arrayContaining([
        expect.objectContaining({ id: 1001, media: expect.any(Object) }),
        expect.objectContaining({ id: 1002, media: expect.any(Object) })
      ]),
      userId
    );
    expect(mockLock.release).toHaveBeenCalledWith("9999", "test-instance");
  });

  test("should flush expired buffer during cleanup", async () => {
    const userId = "user-1";

    mockLock.acquire.mockResolvedValue({ success: true, version: "v1" });
    mockLock.getLockStatus.mockResolvedValue({ status: "held", owner: "test-instance", version: "v1" });

    client.getMessages.mockResolvedValue([
      { id: 1001, media: { className: "MessageMediaPhoto" } }
    ]);

    store.set(`${baseKey}:index`, { gids: ["9999"] });
    store.set(`${baseKey}:timer:9999`, { expiresAt: Date.now() - 1000, updatedAt: Date.now(), instanceId: "test-instance" });
    store.set(`${baseKey}:buffer:9999`, {
      target: { userId: "500" },
      userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: "1001", _seq: 1 }]
    });

    await buffer._cleanupStaleBuffers();

    expect(TaskManager.addBatchTasks).toHaveBeenCalled();
    expect(mockLock.acquire).toHaveBeenCalledWith("9999", "test-instance");
  });

  test("should persist snapshot to persistKey", async () => {
    const userId = "user-1";

    store.set(`${baseKey}:index`, { gids: ["9999"] });
    store.set(`${baseKey}:buffer:9999`, {
      target: { userId: "500" },
      userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: "1001", _seq: 1 }]
    });

    await buffer.persist();

    expect(cache.set).toHaveBeenCalledWith(
      "test-instance:media_group_buffer",
      expect.objectContaining({ instanceId: "test-instance", buffers: expect.any(Array) }),
      60
    );
  });

  test("should restore by scanning cache buffers", async () => {
    const userId = "user-1";

    mockLock.acquire.mockResolvedValue({ success: true, version: "v1" });
    mockLock.getLockStatus.mockResolvedValue({ status: "held", owner: "test-instance", version: "v1" });

    client.getMessages.mockResolvedValue([
      { id: 1001, media: { className: "MessageMediaPhoto" } }
    ]);

    store.set(`${baseKey}:index`, { gids: ["9999"] });
    store.set(`${baseKey}:buffer:9999`, {
      target: { userId: "500" },
      userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ id: "1001", _seq: 1 }]
    });

    await buffer.restore();

    expect(TaskManager.addBatchTasks).toHaveBeenCalled();
  });

  test("should store only serializable data (no BigInt fields) in buffer", async () => {
    const message = { id: 1001n, media: { className: "MessageMediaPhoto" }, groupedId: 9999n };
    const target = new Api.PeerUser({ userId: 500n });
    const userId = "user-1";

    await buffer.add(message, target, userId);

    const buf = store.get(`${baseKey}:buffer:9999`);
    // Verify the entire buffer is JSON-serializable (no BigInt)
    expect(() => JSON.stringify(buf)).not.toThrow();
  });
});
