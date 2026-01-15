/**
 * MediaGroupBuffer_simple.test.js
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { MediaGroupBuffer } from "../../src/services/MediaGroupBuffer.js";
import { cache } from "../../src/services/CacheService.js";

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

describe("MediaGroupBuffer (simple)", () => {
  let buffer;

  beforeEach(() => {
    vi.clearAllMocks();
    buffer = new MediaGroupBuffer({ instanceId: "test-instance", cleanupInterval: 60_000 });
  });

  afterEach(() => {
    buffer.stopCleanup();
    buffer.cleanup();
  });

  test("should create instance with correct persistKey", () => {
    expect(buffer.persistKey).toBe("test-instance:media_group_buffer");
  });

  test("should detect duplicate message", async () => {
    cache.get.mockResolvedValue("1");
    const result = await buffer.add({ id: "msg-1", media: { file_id: "x" }, groupedId: "group-123" }, { id: "t" }, "u");
    expect(result).toEqual({ added: false, reason: "duplicate" });
  });
});

