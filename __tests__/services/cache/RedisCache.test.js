import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import { globalMocks, mockRedisConstructor } from "../../setup/external-mocks.js";

const defaultConfig = { url: "redis://localhost:6379" };

const importRedisCache = async () => {
  const module = await import("../../../src/services/cache/RedisCache.js");
  return module.RedisCache;
};

const createPipeline = () => ({
  set: jest.fn().mockReturnThis(),
  del: jest.fn().mockReturnThis(),
  exec: jest.fn().mockResolvedValue([])
});

const resetRedisClientMocks = () => {
  globalMocks.redisClient.connect.mockReset().mockResolvedValue(undefined);
  globalMocks.redisClient.quit.mockReset().mockResolvedValue("OK");
  globalMocks.redisClient.disconnect.mockReset().mockResolvedValue("OK");
  globalMocks.redisClient.get.mockReset().mockResolvedValue(null);
  globalMocks.redisClient.set.mockReset().mockResolvedValue("OK");
  globalMocks.redisClient.del.mockReset().mockResolvedValue(1);
  globalMocks.redisClient.on.mockReset().mockReturnThis();
  globalMocks.redisClient.once.mockReset().mockReturnThis();
  globalMocks.redisClient.removeListener.mockReset().mockReturnThis();
  globalMocks.redisClient.removeAllListeners.mockReset().mockReturnThis();
  globalMocks.redisClient.pipeline.mockReset().mockImplementation(createPipeline);
  globalMocks.redisClient.multi.mockReset().mockImplementation(createPipeline);
  globalMocks.redisClient.status = "ready";
  mockRedisConstructor.mock.calls = [];
};

const buildCache = async (config = defaultConfig) => {
  const RedisCache = await importRedisCache();
  return new RedisCache(config);
};

beforeEach(() => {
  resetRedisClientMocks();
});

describe("RedisCache", () => {
  test("should instantiate with provided url", async () => {
    const cache = await buildCache();
    expect(cache.options.url).toBe(defaultConfig.url);
  });

  test("should pass url as first argument to ioredis constructor", async () => {
    await buildCache();
    const constructorCalls = mockRedisConstructor.mock.calls;
    expect(constructorCalls.length).toBeGreaterThan(0);
    expect(constructorCalls[0][0]).toBe(defaultConfig.url);
  });

  test("should connect successfully", async () => {
    const cache = await buildCache();

    expect(cache.client).toBeDefined();
    expect(typeof cache.client.connect).toBe("function");

    globalMocks.redisClient.status = "end";
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

  test("should disconnect and flip connection flag", async () => {
    const cache = await buildCache();
    await cache.connect();
    await cache.disconnect();

    expect(globalMocks.redisClient.quit).toHaveBeenCalledTimes(1);
    expect(cache.connected).toBe(false);
  });

  test("should expose provider name", async () => {
    const cache = await buildCache();
    expect(cache.getProviderName()).toBe("Redis");
  });

  test("should return connection info", async () => {
    const cache = await buildCache({ url: defaultConfig.url, name: "test-redis" });
    await cache.connect();

    const info = cache.getConnectionInfo();

    expect(info).toEqual({
      provider: "Redis",
      name: "test-redis",
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

  test("should support atomic operations (pipeline)", async () => {
    const cache = await buildCache();
    await cache.connect();

    const multi = cache.client.multi();

    expect(multi).toBeDefined();
    expect(typeof multi.set).toBe("function");
    expect(typeof multi.del).toBe("function");
    expect(typeof multi.exec).toBe("function");
  });
});
