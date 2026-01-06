import { describe, test, expect, beforeEach } from "@jest/globals";
import { globalMocks } from "../../setup/external-mocks.js";

const defaultConfig = { url: "redis://localhost:6379" };

const importValkeyCache = async () => {
  const module = await import("../../../src/services/cache/ValkeyCache.js");
  return module.ValkeyCache;
};

const resetRedisClientMocks = () => {
  globalMocks.redisClient.connect.mockReset().mockResolvedValue(undefined);
  globalMocks.redisClient.get.mockReset().mockResolvedValue(null);
  globalMocks.redisClient.set.mockReset().mockResolvedValue("OK");
  globalMocks.redisClient.del.mockReset().mockResolvedValue(1);
  globalMocks.redisClient.exists.mockReset().mockResolvedValue(0);
  globalMocks.redisClient.incr.mockReset().mockResolvedValue(1);
  globalMocks.redisClient.eval.mockReset().mockResolvedValue(1);
  globalMocks.redisClient.scan.mockReset().mockResolvedValue(['0', []]);
  globalMocks.redisClient.quit.mockReset().mockResolvedValue("OK");
  globalMocks.redisClient.disconnect.mockReset().mockResolvedValue("OK");
  globalMocks.redisClient.on.mockReset().mockReturnThis();
  globalMocks.redisClient.once.mockReset().mockReturnThis();
  globalMocks.redisClient.removeListener.mockReset().mockReturnThis();
  globalMocks.redisClient.removeAllListeners.mockReset().mockReturnThis();
};

const buildCache = async (config = defaultConfig) => {
  const ValkeyCache = await importValkeyCache();
  return new ValkeyCache(config);
};

beforeEach(() => {
  resetRedisClientMocks();
});

describe("ValkeyCache", () => {
  test("should instantiate with correct URL", async () => {
    const cache = await buildCache();

    expect(cache.options.url).toBe(defaultConfig.url);
    expect(cache.client).toBeDefined();
  });

  test("should instantiate with name", async () => {
    const cache = await buildCache({ ...defaultConfig, name: "my-valkey" });
    expect(cache.options.name).toBe("my-valkey");
  });

  test("should connect successfully", async () => {
    const cache = await buildCache();
    await cache.connect();

    expect(globalMocks.redisClient.connect).toHaveBeenCalledTimes(1);
    expect(cache.connected).toBe(true);
  });

  test("should get value as JSON by default", async () => {
    globalMocks.redisClient.get.mockResolvedValueOnce('{"data":"test"}');

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.get("key", "json");

    expect(globalMocks.redisClient.get).toHaveBeenCalledWith("key");
    expect(result).toEqual({ data: "test" });
  });

  test("should get value as string", async () => {
    globalMocks.redisClient.get.mockResolvedValueOnce("test-value");

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.get("key", "string");

    expect(globalMocks.redisClient.get).toHaveBeenCalledWith("key");
    expect(result).toBe("test-value");
  });

  test("should return null for missing key", async () => {
    globalMocks.redisClient.get.mockResolvedValueOnce(null);

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.get("missing-key");

    expect(result).toBe(null);
  });

  test("should set value with TTL", async () => {
    const cache = await buildCache();
    await cache.connect();

    const result = await cache.set("key", { data: "test" }, 3600);

    expect(globalMocks.redisClient.set).toHaveBeenCalledWith("key", '{"data":"test"}', "EX", 3600);
    expect(result).toBe(true);
  });

  test("should set string value", async () => {
    const cache = await buildCache();
    await cache.connect();

    const result = await cache.set("key", "test-value", 3600);

    expect(globalMocks.redisClient.set).toHaveBeenCalledWith("key", "test-value", "EX", 3600);
    expect(result).toBe(true);
  });

  test("should delete key", async () => {
    const cache = await buildCache();
    await cache.connect();

    const result = await cache.delete("key");

    expect(globalMocks.redisClient.del).toHaveBeenCalledWith("key");
    expect(result).toBe(true);
  });

  test("should check existence", async () => {
    globalMocks.redisClient.exists.mockResolvedValueOnce(1);

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.exists("key");

    expect(globalMocks.redisClient.exists).toHaveBeenCalledWith("key");
    expect(result).toBe(true);
  });

  test("should increment value", async () => {
    globalMocks.redisClient.incr.mockResolvedValueOnce(7);

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.incr("counter");

    expect(globalMocks.redisClient.incr).toHaveBeenCalledWith("counter");
    expect(result).toBe(7);
  });

  test("should acquire lock", async () => {
    globalMocks.redisClient.set.mockResolvedValueOnce("OK");

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.lock("lock:key", 20);

    expect(globalMocks.redisClient.set).toHaveBeenCalledWith("lock:key", 1, "NX", "PX", 20000);
    expect(result).toBe(true);
  });

  test("should release lock", async () => {
    globalMocks.redisClient.eval.mockResolvedValueOnce(1);

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.unlock("lock:key");

    expect(globalMocks.redisClient.eval).toHaveBeenCalled();
    expect(result).toBe(true);
  });

  test("should list keys by prefix using scan", async () => {
    globalMocks.redisClient.scan
      .mockResolvedValueOnce(["1", ["instance:one"]])
      .mockResolvedValueOnce(["0", ["instance:two"]]);

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.listKeys("instance:");

    expect(globalMocks.redisClient.scan).toHaveBeenCalledWith("0", "MATCH", "instance:*", "COUNT", 200);
    expect(result).toEqual(["instance:one", "instance:two"]);
  });

  test("should respect listKeys limit", async () => {
    globalMocks.redisClient.scan
      .mockResolvedValueOnce(["1", ["instance:one", "instance:two"]])
      .mockResolvedValueOnce(["0", ["instance:three"]]);

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.listKeys("instance:", 2);

    expect(result).toEqual(["instance:one", "instance:two"]);
  });

  test("should disconnect", async () => {
    const cache = await buildCache();
    await cache.connect();
    await cache.disconnect();

    expect(globalMocks.redisClient.quit).toHaveBeenCalledTimes(1);
    expect(cache.connected).toBe(false);
  });

  test("should get provider name", async () => {
    const cache = await buildCache();
    expect(cache.getProviderName()).toBe("Valkey");
  });

  test("should get connection info", async () => {
    const cache = await buildCache({ ...defaultConfig, name: "test-valkey" });
    await cache.connect();

    const info = cache.getConnectionInfo();

    expect(info).toEqual({
      provider: "Valkey",
      name: "test-valkey",
      url: defaultConfig.url,
      status: "ready"
    });
  });

  test("should handle JSON serialization errors", async () => {
    const cache = await buildCache();
    await cache.connect();

    const circularObj = {};
    circularObj.self = circularObj;

    const result = await cache.set("key", circularObj, 3600);

    expect(result).toBe(false);
  });

  test("should handle JSON parsing errors", async () => {
    globalMocks.redisClient.get.mockResolvedValueOnce("invalid-json");

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.get("key", "json");

    expect(result).toBe(null);
  });
});
