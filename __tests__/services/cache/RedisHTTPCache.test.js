import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { RedisHTTPCache } from "../../../src/services/cache/RedisHTTPCache.js";

const originalFetch = global.fetch;

const mockFetchResult = (result) => {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    json: vi.fn().mockResolvedValue({ result })
  });
};

describe("RedisHTTPCache", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("should compareAndSet with ifNotExists condition through EVAL", async () => {
    mockFetchResult(1);
    const cache = new RedisHTTPCache({ url: "https://redis.example.com", token: "token" });

    const result = await cache.compareAndSet("lock:telegram_client", { instanceId: "one" }, {
      ifNotExists: true,
      ttl: 90
    });

    expect(result).toBe(true);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body[0]).toBe("EVAL");
    expect(body[2]).toBe("1");
    expect(body[3]).toBe("lock:telegram_client");
    expect(body[4]).toBe('{"instanceId":"one"}');
    expect(body[5]).toBe(90);
    expect(body[6]).toBe("ifNotExists");
    expect(body[7]).toBe("");
  });

  test("should compareAndSet with ifEquals condition through EVAL", async () => {
    mockFetchResult(1);
    const cache = new RedisHTTPCache({ url: "https://redis.example.com", token: "token" });

    const result = await cache.compareAndSet("lock:telegram_client", { instanceId: "two" }, {
      ifEquals: { instanceId: "one" }
    });

    expect(result).toBe(true);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body[6]).toBe("ifEquals");
    expect(body[7]).toBe('{"instanceId":"one"}');
  });

  test("should return false when compareAndSet condition does not match", async () => {
    mockFetchResult(0);
    const cache = new RedisHTTPCache({ url: "https://redis.example.com", token: "token" });

    const result = await cache.compareAndSet("key", "value", { ifNotExists: true });

    expect(result).toBe(false);
  });
});
