import { describe, test, expect, beforeEach } from "@jest/globals";
import { globalMocks } from "../../setup/external-mocks.js";

const defaultConfig = { url: "rediss://redis-host:6380" };

const importRedisTLSCache = async () => {
  const module = await import("../../../src/services/cache/RedisTLSCache.js");
  return module.RedisTLSCache;
};

const resetRedisClientMocks = () => {
  globalMocks.redisClient.connect.mockReset().mockResolvedValue(undefined);
  globalMocks.redisClient.get.mockReset().mockResolvedValue(null);
  globalMocks.redisClient.set.mockReset().mockResolvedValue("OK");
  globalMocks.redisClient.del.mockReset().mockResolvedValue(1);
  globalMocks.redisClient.quit.mockReset().mockResolvedValue("OK");
  globalMocks.redisClient.disconnect.mockReset().mockResolvedValue("OK");
  globalMocks.redisClient.on.mockReset().mockReturnThis();
  globalMocks.redisClient.once.mockReset().mockReturnThis();
  globalMocks.redisClient.removeListener.mockReset().mockReturnThis();
  globalMocks.redisClient.removeAllListeners.mockReset().mockReturnThis();
};

const buildCache = async (config) => {
  const RedisTLSCache = await importRedisTLSCache();
  return new RedisTLSCache(config);
};

beforeEach(() => {
  resetRedisClientMocks();
});

describe("RedisTLSCache", () => {
  test("should instantiate with TLS options", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      rejectUnauthorized: true,
      servername: "redis-host"
    });

    expect(cache.options.url).toBe(defaultConfig.url);
    expect(cache.options.tls).toEqual({
      rejectUnauthorized: true,
      servername: "redis-host"
    });
  });

  test("should default rejectUnauthorized to true", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      servername: "redis-host"
    });

    expect(cache.options.tls).toEqual({
      rejectUnauthorized: true,
      servername: "redis-host"
    });
  });

  test("should allow disabling rejectUnauthorized", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      rejectUnauthorized: false,
      servername: "redis-host"
    });

    expect(cache.options.tls).toEqual({
      rejectUnauthorized: false,
      servername: "redis-host"
    });
  });

  test("should connect successfully with TLS", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      rejectUnauthorized: true
    });

    globalMocks.redisClient.status = "end";
    await cache.connect();

    expect(globalMocks.redisClient.connect).toHaveBeenCalledTimes(1);
    expect(cache.connected).toBe(true);
  });

  test("should get provider name", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      rejectUnauthorized: true
    });

    expect(cache.getProviderName()).toBe("RedisTLS");
  });

  test("should get connection info with TLS details", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      rejectUnauthorized: true,
      servername: "redis-host",
      name: "secure-redis"
    });

    globalMocks.redisClient.status = "end";
    await cache.connect();

    const info = cache.getConnectionInfo();

    expect(info).toEqual({
      provider: "RedisTLS",
      name: "secure-redis",
      url: defaultConfig.url,
      tls: true,
      status: "ready"
    });
  });

  test("should handle standard operations over TLS", async () => {
    globalMocks.redisClient.get.mockResolvedValueOnce('{"secure":"data"}');

    const cache = await buildCache({
      url: defaultConfig.url,
      rejectUnauthorized: true
    });

    globalMocks.redisClient.status = "end";
    await cache.connect();

    const setResult = await cache.set("secure-key", { secure: "data" }, 3600);
    expect(setResult).toBe(true);
    expect(globalMocks.redisClient.set).toHaveBeenCalledWith("secure-key", '{"secure":"data"}', "EX", 3600);

    const getResult = await cache.get("secure-key", "json");
    expect(getResult).toEqual({ secure: "data" });
    expect(globalMocks.redisClient.get).toHaveBeenCalledWith("secure-key");

    const delResult = await cache.delete("secure-key");
    expect(delResult).toBe(true);
    expect(globalMocks.redisClient.del).toHaveBeenCalledWith("secure-key");
  });

  test("should disconnect properly", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      rejectUnauthorized: true
    });

    globalMocks.redisClient.status = "end";
    await cache.connect();
    await cache.disconnect();

    expect(globalMocks.redisClient.quit).toHaveBeenCalledTimes(1);
    expect(cache.connected).toBe(false);
  });
});
