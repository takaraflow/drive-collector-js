import { initConfig, getRedisConnectionConfig, __resetConfigForTests, CACHE_TTL } from "../../src/config/index.js";

// Store original process.env
const originalEnv = { ...process.env };

describe("Config Module", () => {
  beforeAll(() => {
    // Set up mock environment variables
    process.env.API_ID = "12345";
    process.env.API_HASH = "mock_hash";
    process.env.BOT_TOKEN = "mock_token";
    process.env.OWNER_ID = "owner_id";
    process.env.RCLONE_REMOTE = "mega_test";
    process.env.REMOTE_FOLDER = "/test";
    process.env.PORT = "8080";
    process.env.TELEGRAM_PROXY_HOST = "proxy.example.com";
    process.env.TELEGRAM_PROXY_PORT = "1080";
    process.env.TELEGRAM_PROXY_TYPE = "socks5";
    process.env.TELEGRAM_PROXY_USERNAME = "proxy_user";
    process.env.TELEGRAM_PROXY_PASSWORD = "proxy_pass";
  });

  afterAll(() => {
    // Restore original environment variables
    process.env = { ...originalEnv };
  });

  test("should have the required config object and properties", async () => {
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
    // CACHE_TTL is exported as a named export
    expect(CACHE_TTL).toBeDefined();
    expect(typeof CACHE_TTL).toBe("number");
    expect(CACHE_TTL).toBe(10 * 60 * 1000);
  });

  test("should respect REDIS_TLS_ENABLED=false to override rediss://", async () => {
    // Test case 1: rediss:// URL with TLS disabled
    process.env.NF_REDIS_URL = "rediss://user:pass@redis.example.com:6379";
    process.env.REDIS_TLS_ENABLED = "false";
    
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

    __resetConfigForTests();
    await initConfig();
    const { options } = getRedisConnectionConfig();
    expect(options.password).toBe("priority_token");

    // Clean up
    delete process.env.REDIS_URL;
    delete process.env.REDIS_TOKEN;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  test("should map Cloudflare KV configuration correctly", async () => {
    process.env.CLOUDFLARE_KV_ACCOUNT_ID = "acc_kv";
    process.env.CLOUDFLARE_KV_NAMESPACE_ID = "ns_kv";
    process.env.CLOUDFLARE_KV_TOKEN = "tok_kv";

    __resetConfigForTests();
    const config = await initConfig();
    expect(config.kv.accountId).toBe("acc_kv");
    expect(config.kv.namespaceId).toBe("ns_kv");
    expect(config.kv.token).toBe("tok_kv");

    delete process.env.CLOUDFLARE_KV_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_KV_NAMESPACE_ID;
    delete process.env.CLOUDFLARE_KV_TOKEN;
  });

  test("should fallback to CLOUDFLARE_ACCOUNT_ID for KV", async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc_gen";
    process.env.CLOUDFLARE_KV_NAMESPACE_ID = "ns_kv";
    process.env.CLOUDFLARE_KV_TOKEN = "tok_kv";

    __resetConfigForTests();
    const config = await initConfig();
    expect(config.kv.accountId).toBe("acc_gen");

    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_KV_NAMESPACE_ID;
    delete process.env.CLOUDFLARE_KV_TOKEN;
  });

  test("should map Cloudflare D1 configuration correctly", async () => {
    process.env.CLOUDFLARE_D1_ACCOUNT_ID = "acc_d1";
    process.env.CLOUDFLARE_D1_DATABASE_ID = "db_d1";
    process.env.CLOUDFLARE_D1_TOKEN = "tok_d1";

    __resetConfigForTests();
    const config = await initConfig();
    expect(config.d1.accountId).toBe("acc_d1");
    expect(config.d1.databaseId).toBe("db_d1");
    expect(config.d1.token).toBe("tok_d1");

    delete process.env.CLOUDFLARE_D1_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_D1_DATABASE_ID;
    delete process.env.CLOUDFLARE_D1_TOKEN;
  });
});
