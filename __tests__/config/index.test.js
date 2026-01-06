import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";

// Store original process.env
const originalEnv = process.env;

describe("Config Module", () => {
  beforeAll(() => {
    // Set up mock environment variables
    process.env = {
      ...originalEnv,
      API_ID: "12345",
      API_HASH: "mock_hash",
      BOT_TOKEN: "mock_token",
      OWNER_ID: "owner_id",
      RCLONE_REMOTE: "mega_test",
      REMOTE_FOLDER: "/test",
      PORT: "8080",
      TELEGRAM_PROXY_HOST: "proxy.example.com",
      TELEGRAM_PROXY_PORT: "1080",
      TELEGRAM_PROXY_TYPE: "socks5",
      TELEGRAM_PROXY_USERNAME: "proxy_user",
      TELEGRAM_PROXY_PASSWORD: "proxy_pass",
    };
  });

  afterAll(() => {
    // Restore original environment variables
    process.env = originalEnv;
  });

  test("should have the required config object and properties", async () => {
    // Dynamically import the module to use the mocked env
    const { initConfig, __resetConfigForTests } = await import("../../src/config/index.js");
    __resetConfigForTests();
    const config = await initConfig();
    expect(config).toBeDefined();
    expect(typeof config).toBe("object");

    // Check properties
    expect(config.apiId).toBe(12345);
    expect(config.apiHash).toBe("mock_hash");
    expect(config.botToken).toBe("mock_token");
    expect(config.ownerId).toBe("owner_id");
    expect(config.remoteName).toBe("mega_test");
    expect(config.remoteFolder).toBe("/test");
    
    // Check telegram proxy configuration
    expect(config.telegram).toBeDefined();
    expect(config.telegram.proxy).toBeDefined();
    expect(config.telegram.proxy.host).toBe("proxy.example.com");
    expect(config.telegram.proxy.port).toBe(1080);
    expect(config.telegram.proxy.type).toBe("socks5");
    expect(config.telegram.proxy.username).toBe("proxy_user");
    expect(config.telegram.proxy.password).toBe("proxy_pass");
  });

  test("should have the CACHE_TTL constant", async () => {
    const { CACHE_TTL } = await import("../../src/config/index.js");
    // CACHE_TTL is exported as a named export
    expect(CACHE_TTL).toBeDefined();
    expect(typeof CACHE_TTL).toBe("number");
    expect(CACHE_TTL).toBe(10 * 60 * 1000);
  });

  test("should respect REDIS_TLS_ENABLED=false to override rediss://", async () => {
    // Test case 1: rediss:// URL with TLS disabled
    process.env.NF_REDIS_URL = "rediss://user:pass@redis.example.com:6379";
    process.env.REDIS_TLS_ENABLED = "false";
    
    const { initConfig, __resetConfigForTests } = await import("../../src/config/index.js");
    __resetConfigForTests();
    const config1 = await initConfig();
    expect(config1.redis.tls.enabled).toBe(false);
    
    // Clean up
    delete process.env.NF_REDIS_URL;
    delete process.env.REDIS_TLS_ENABLED;
  });

  test("should enable TLS for rediss:// URL when not explicitly disabled", async () => {
    // Test case 2: rediss:// URL without TLS disabled
    process.env.NF_REDIS_URL = "rediss://user:pass@redis.example.com:6379";
    
    const { initConfig, __resetConfigForTests } = await import("../../src/config/index.js");
    __resetConfigForTests();
    const config2 = await initConfig();
    expect(config2.redis.tls.enabled).toBe(true);
    
    // Clean up
    delete process.env.NF_REDIS_URL;
  });

  test("should respect NF_REDIS_TLS_ENABLED=false", async () => {
    // Test case 3: NF_REDIS_TLS_ENABLED=false
    process.env.NF_REDIS_URL = "rediss://user:pass@redis.example.com:6379";
    process.env.NF_REDIS_TLS_ENABLED = "false";
    
    const { initConfig, __resetConfigForTests } = await import("../../src/config/index.js");
    __resetConfigForTests();
    const config3 = await initConfig();
    expect(config3.redis.tls.enabled).toBe(false);
    
    // Clean up
    delete process.env.NF_REDIS_URL;
    delete process.env.NF_REDIS_TLS_ENABLED;
  });

  test("should use REDIS_TOKEN when password is not provided in URL", async () => {
    process.env.REDIS_URL = "redis://redis.example.com:6379";
    process.env.REDIS_TOKEN = "test_token_123";

    const { initConfig, getRedisConnectionConfig, __resetConfigForTests } = await import("../../src/config/index.js");
    __resetConfigForTests();
    await initConfig();
    const { options } = getRedisConnectionConfig();
    expect(options.password).toBe("test_token_123");

    // Clean up
    delete process.env.REDIS_URL;
    delete process.env.REDIS_TOKEN;
  });

  test("should use UPSTASH_REDIS_REST_TOKEN as fallback for Redis password", async () => {
    process.env.REDIS_URL = "redis://redis.example.com:6379";
    process.env.UPSTASH_REDIS_REST_TOKEN = "upstash_token_123";

    const { initConfig, getRedisConnectionConfig, __resetConfigForTests } = await import("../../src/config/index.js");
    __resetConfigForTests();
    await initConfig();
    const { options } = getRedisConnectionConfig();
    expect(options.password).toBe("upstash_token_123");

    // Clean up
    delete process.env.REDIS_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  test("should prioritize REDIS_TOKEN over UPSTASH_REDIS_REST_TOKEN", async () => {
    process.env.REDIS_URL = "redis://redis.example.com:6379";
    process.env.REDIS_TOKEN = "priority_token";
    process.env.UPSTASH_REDIS_REST_TOKEN = "upstash_token_123";

    const { initConfig, getRedisConnectionConfig, __resetConfigForTests } = await import("../../src/config/index.js");
    __resetConfigForTests();
    await initConfig();
    const { options } = getRedisConnectionConfig();
    expect(options.password).toBe("priority_token");

    // Clean up
    delete process.env.REDIS_URL;
    delete process.env.REDIS_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });
});
