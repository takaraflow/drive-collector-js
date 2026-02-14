import { globalMocks, mockRedisConstructor } from "../../setup/external-mocks.js";

const defaultConfig = { url: "redis://localhost:6379" };

const importRedisCache = async () => {
  const module = await import("../../../src/services/cache/RedisCache.js");
  return module.RedisCache;
};

const createPipeline = () => ({
  set: vi.fn().mockReturnThis(),
  del: vi.fn().mockReturnThis(),
  exec: vi.fn().mockResolvedValue([])
});

const resetRedisClientMocks = () => {
  globalMocks.redisClient.connect.mockReset().mockResolvedValue(undefined);
  globalMocks.redisClient.quit.mockReset().mockResolvedValue("OK");
  globalMocks.redisClient.disconnect.mockReset().mockResolvedValue("OK");
  globalMocks.redisClient.get.mockReset().mockResolvedValue(null);
  globalMocks.redisClient.set.mockReset().mockResolvedValue("OK");
  globalMocks.redisClient.del.mockReset().mockResolvedValue(1);
  globalMocks.redisClient.exists.mockReset().mockResolvedValue(0);
  globalMocks.redisClient.incr.mockReset().mockResolvedValue(1);
  globalMocks.redisClient.eval.mockReset().mockResolvedValue(1);
  globalMocks.redisClient.scan.mockReset().mockResolvedValue(['0', []]);
  globalMocks.redisClient.on.mockReset().mockReturnThis();
  globalMocks.redisClient.once.mockReset().mockReturnThis();
  globalMocks.redisClient.removeListener.mockReset().mockReturnThis();
  globalMocks.redisClient.removeAllListeners.mockReset().mockReturnThis();
  globalMocks.redisClient.pipeline.mockReset().mockImplementation(createPipeline);
  globalMocks.redisClient.multi.mockReset().mockImplementation(createPipeline);
  globalMocks.redisClient.status = "ready";
  mockRedisConstructor.mockClear();
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

      // Set status on the actual instance to trigger connect logic
      cache.client.status = "end";
      // For RedisCache.connect(), when client has connect method, it should call it
      cache.client.connect.mockResolvedValueOnce(undefined);
      await cache.connect();

      expect(cache.client.connect).toHaveBeenCalledTimes(1);
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
    globalMocks.redisClient.incr.mockResolvedValueOnce(5);

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.incr("counter");

    expect(globalMocks.redisClient.incr).toHaveBeenCalledWith("counter");
    expect(result).toBe(5);
  });

  test("should acquire lock", async () => {
    globalMocks.redisClient.set.mockResolvedValueOnce("OK");

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.lock("lock:key", 30);

    expect(globalMocks.redisClient.set).toHaveBeenCalledWith("lock:key", 1, "NX", "PX", 30000);
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

  test("should compareAndSet with ifNotExists condition", async () => {
    globalMocks.redisClient.eval.mockResolvedValueOnce(1);

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.compareAndSet("key", { data: "value" }, { ifNotExists: true });

    expect(globalMocks.redisClient.eval).toHaveBeenCalledTimes(1);
    const evalCall = globalMocks.redisClient.eval.mock.calls[0];
    expect(evalCall[1]).toBe(1); // 1 key
    expect(evalCall[2]).toBe("key"); // key name
    expect(evalCall[3]).toBe('{"data":"value"}'); // serialized value
    expect(evalCall[4]).toBe(3600); // ttl
    expect(evalCall[5]).toBe("ifNotExists"); // condition
    expect(evalCall[6]).toBe(""); // expected
    expect(result).toBe(true);
  });

  test("should compareAndSet with ifEquals condition", async () => {
    globalMocks.redisClient.eval.mockResolvedValueOnce(1);

    const cache = await buildCache();
    await cache.connect();

    const current = { version: 1 };
    const next = { version: 2 };
    const result = await cache.compareAndSet("key", next, { ifEquals: current });

    expect(globalMocks.redisClient.eval).toHaveBeenCalledTimes(1);
    const evalCall = globalMocks.redisClient.eval.mock.calls[0];
    expect(evalCall[5]).toBe("ifEquals"); // condition
    expect(evalCall[6]).toBe('{"version":1}'); // expected serialized
    expect(result).toBe(true);
  });

  test("should compareAndSet unconditionally by default", async () => {
    globalMocks.redisClient.eval.mockResolvedValueOnce(1);

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.compareAndSet("key", "value");

    expect(globalMocks.redisClient.eval).toHaveBeenCalledTimes(1);
    const evalCall = globalMocks.redisClient.eval.mock.calls[0];
    expect(evalCall[5]).toBe("default"); // condition
    expect(result).toBe(true);
  });

  test("should handle compareAndSet failure", async () => {
    globalMocks.redisClient.eval.mockResolvedValueOnce(0);

    const cache = await buildCache();
    await cache.connect();

    const result = await cache.compareAndSet("key", "value", { ifNotExists: true });

    expect(result).toBe(false);
  });

  test("should handle compareAndSet with custom TTL", async () => {
    globalMocks.redisClient.eval.mockResolvedValueOnce(1);

    const cache = await buildCache();
    await cache.connect();

    await cache.compareAndSet("key", "value", { ttl: 7200 });

    const evalCall = globalMocks.redisClient.eval.mock.calls[0];
    expect(evalCall[4]).toBe(7200); // custom ttl
  });
});
