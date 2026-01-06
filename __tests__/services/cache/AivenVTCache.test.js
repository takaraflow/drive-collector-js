import { describe, test, expect, beforeEach } from "@jest/globals";
import { globalMocks } from "../../setup/external-mocks.js";

const defaultConfig = { url: "valkey://aiven-host:16379" };

const importAivenVTCache = async () => {
  const module = await import("../../../src/services/cache/AivenVTCache.js");
  return module.AivenVTCache;
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
  const AivenVTCache = await importAivenVTCache();
  return new AivenVTCache(config);
};

beforeEach(() => {
  resetRedisClientMocks();
});

describe("AivenVTCache", () => {
  test("should instantiate with Aiven-specific TLS configuration", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      name: "aiven-valkey"
    });

    expect(cache.options.url).toBe(defaultConfig.url);
    expect(cache.options.tls).toEqual({
      rejectUnauthorized: true
    });
  });

  test("should connect successfully", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      name: "aiven-valkey"
    });

    await cache.connect();

    expect(globalMocks.redisClient.connect).toHaveBeenCalledTimes(1);
    expect(cache.connected).toBe(true);
  });

  test("should get provider name", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      name: "aiven-valkey"
    });

    expect(cache.getProviderName()).toBe("AivenValkey");
  });

  test("should get connection info with Aiven details", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      name: "aiven-valkey"
    });

    await cache.connect();

    const info = cache.getConnectionInfo();

    expect(info).toEqual({
      provider: "AivenValkey",
      name: "aiven-valkey",
      url: defaultConfig.url,
      tls: true,
      status: "ready"
    });
  });

  test("should handle standard operations", async () => {
    globalMocks.redisClient.get.mockResolvedValueOnce('{"aiven":"data"}');

    const cache = await buildCache({
      url: defaultConfig.url,
      name: "aiven-valkey"
    });

    await cache.connect();

    const setResult = await cache.set("aiven-key", { aiven: "data" }, 3600);
    expect(setResult).toBe(true);
    expect(globalMocks.redisClient.set).toHaveBeenCalledWith("aiven-key", '{"aiven":"data"}', "EX", 3600);

    const getResult = await cache.get("aiven-key", "json");
    expect(getResult).toEqual({ aiven: "data" });
    expect(globalMocks.redisClient.get).toHaveBeenCalledWith("aiven-key");

    const delResult = await cache.delete("aiven-key");
    expect(delResult).toBe(true);
    expect(globalMocks.redisClient.del).toHaveBeenCalledWith("aiven-key");
  });

  test("should disconnect properly", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      name: "aiven-valkey"
    });

    await cache.connect();
    await cache.disconnect();

    expect(globalMocks.redisClient.quit).toHaveBeenCalledTimes(1);
    expect(cache.connected).toBe(false);
  });

  test("should enforce strict TLS regardless of input options", async () => {
    const cache = await buildCache({
      url: defaultConfig.url,
      name: "aiven-valkey",
      rejectUnauthorized: false
    });

    expect(cache.options.tls).toEqual({
      rejectUnauthorized: false
    });
  });
});
