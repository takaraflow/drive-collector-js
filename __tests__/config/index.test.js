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

  test("should default message slow response warning threshold to 2000ms", async () => {
    delete process.env.MESSAGE_SLOW_WARN_THRESHOLD_MS;

    __resetConfigForTests();
    const config = await initConfig();

    expect(config.performance.messageSlowWarnThresholdMs).toBe(2000);
  });

  test("should allow message slow response warning threshold override", async () => {
    process.env.MESSAGE_SLOW_WARN_THRESHOLD_MS = "3500";

    __resetConfigForTests();
    const config = await initConfig();

    expect(config.performance.messageSlowWarnThresholdMs).toBe(3500);

    delete process.env.MESSAGE_SLOW_WARN_THRESHOLD_MS;
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
    process.env.DB_AUTO_MIGRATE = "true";
    process.env.DB_SCHEMA_CHECK = "true";
    process.env.DB_MIGRATION_LOCK_TTL_MS = "45000";
    process.env.DB_MIGRATION_LOCK_WAIT_MS = "9000";
    process.env.DB_SCHEMA_READY_RETRY_ATTEMPTS = "5";
    process.env.DB_SCHEMA_READY_RETRY_INITIAL_DELAY_MS = "1500";
    process.env.DB_SCHEMA_READY_RETRY_MAX_DELAY_MS = "12000";

    __resetConfigForTests();
    const config = await initConfig();
    expect(config.d1.accountId).toBe("acc_d1");
    expect(config.d1.databaseId).toBe("db_d1");
    expect(config.d1.token).toBe("tok_d1");
    expect(config.database).toMatchObject({
      schemaCheck: true,
      autoMigrate: true,
      migrationLockTtlMs: 45000,
      migrationLockWaitMs: 9000,
      schemaReadyRetryAttempts: 5,
      schemaReadyRetryInitialDelayMs: 1500,
      schemaReadyRetryMaxDelayMs: 12000
    });

    delete process.env.CLOUDFLARE_D1_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_D1_DATABASE_ID;
    delete process.env.CLOUDFLARE_D1_TOKEN;
    delete process.env.DB_AUTO_MIGRATE;
    delete process.env.DB_SCHEMA_CHECK;
    delete process.env.DB_MIGRATION_LOCK_TTL_MS;
    delete process.env.DB_MIGRATION_LOCK_WAIT_MS;
    delete process.env.DB_SCHEMA_READY_RETRY_ATTEMPTS;
    delete process.env.DB_SCHEMA_READY_RETRY_INITIAL_DELAY_MS;
    delete process.env.DB_SCHEMA_READY_RETRY_MAX_DELAY_MS;
  });

  test("should accept legacy Cloudflare D1 and R2 worker aliases", async () => {
    delete process.env.CLOUDFLARE_D1_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_D1_DATABASE_ID;
    delete process.env.CLOUDFLARE_D1_TOKEN;
    delete process.env.OSS_WORKER_URL;
    delete process.env.OSS_WORKER_SECRET;
    process.env.CF_D1_ACCOUNT_ID = "legacy_acc";
    process.env.CF_D1_DATABASE_ID = "legacy_db";
    process.env.CF_D1_TOKEN = "legacy_token";
    process.env.R2_WORKER_URL = "https://legacy-worker.example.com";
    process.env.R2_WORKER_AUTH_TOKEN = "legacy_worker_token";

    __resetConfigForTests();
    const config = await initConfig();

    expect(config.d1).toMatchObject({
      accountId: "legacy_acc",
      databaseId: "legacy_db",
      token: "legacy_token"
    });
    expect(config.oss).toMatchObject({
      workerUrl: "https://legacy-worker.example.com",
      workerSecret: "legacy_worker_token"
    });

    delete process.env.CF_D1_ACCOUNT_ID;
    delete process.env.CF_D1_DATABASE_ID;
    delete process.env.CF_D1_TOKEN;
    delete process.env.R2_WORKER_URL;
    delete process.env.R2_WORKER_AUTH_TOKEN;
  });

  test("should prefer canonical Cloudflare D1 and OSS worker variables over legacy aliases", async () => {
    process.env.CLOUDFLARE_D1_ACCOUNT_ID = "canonical_acc";
    process.env.CLOUDFLARE_D1_DATABASE_ID = "canonical_db";
    process.env.CLOUDFLARE_D1_TOKEN = "canonical_token";
    process.env.CF_D1_ACCOUNT_ID = "legacy_acc";
    process.env.CF_D1_DATABASE_ID = "legacy_db";
    process.env.CF_D1_TOKEN = "legacy_token";
    process.env.OSS_WORKER_URL = "https://canonical-worker.example.com";
    process.env.OSS_WORKER_SECRET = "canonical_worker_token";
    process.env.R2_WORKER_URL = "https://legacy-worker.example.com";
    process.env.R2_WORKER_AUTH_TOKEN = "legacy_worker_token";

    __resetConfigForTests();
    const config = await initConfig();

    expect(config.d1).toMatchObject({
      accountId: "canonical_acc",
      databaseId: "canonical_db",
      token: "canonical_token"
    });
    expect(config.oss).toMatchObject({
      workerUrl: "https://canonical-worker.example.com",
      workerSecret: "canonical_worker_token"
    });

    delete process.env.CLOUDFLARE_D1_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_D1_DATABASE_ID;
    delete process.env.CLOUDFLARE_D1_TOKEN;
    delete process.env.CF_D1_ACCOUNT_ID;
    delete process.env.CF_D1_DATABASE_ID;
    delete process.env.CF_D1_TOKEN;
    delete process.env.OSS_WORKER_URL;
    delete process.env.OSS_WORKER_SECRET;
    delete process.env.R2_WORKER_URL;
    delete process.env.R2_WORKER_AUTH_TOKEN;
  });

  test("should accept QSTASH_AUTH_TOKEN as fallback for QStash token", async () => {
    delete process.env.QSTASH_TOKEN;
    process.env.QSTASH_AUTH_TOKEN = "legacy-qstash-token";

    __resetConfigForTests();
    const config = await initConfig();
    expect(config.qstash.token).toBe("legacy-qstash-token");

    delete process.env.QSTASH_AUTH_TOKEN;
  });

  test("should fail closed when stream forwarding is enabled without INSTANCE_SECRET", async () => {
    process.env.STREAM_FORWARDING_ENABLED = "true";
    delete process.env.INSTANCE_SECRET;

    __resetConfigForTests();
    const config = await initConfig();

    expect(config.streamForwarding).toMatchObject({
      enabled: true,
      secret: ""
    });

    delete process.env.STREAM_FORWARDING_ENABLED;
  });

  test("should trim configured INSTANCE_SECRET", async () => {
    process.env.STREAM_FORWARDING_ENABLED = "true";
    process.env.INSTANCE_SECRET = "  shared-secret  ";

    __resetConfigForTests();
    const config = await initConfig();

    expect(config.streamForwarding.secret).toBe("shared-secret");

    delete process.env.STREAM_FORWARDING_ENABLED;
    delete process.env.INSTANCE_SECRET;
  });

  test("should default direct transfer to strict zero-disk mode", async () => {
    delete process.env.DIRECT_TRANSFER_ENABLED;
    delete process.env.DIRECT_TRANSFER_FALLBACK_TO_LOCAL;
    delete process.env.DIRECT_TRANSFER_TIMEOUT_MS;
    delete process.env.DIRECT_TRANSFER_STALL_TIMEOUT_MS;

    __resetConfigForTests();
    const config = await initConfig();

    expect(config.directTransfer).toEqual({
      enabled: true,
      fallbackToLocal: false,
      timeoutMs: 21600000,
      stallTimeoutMs: 180000,
      maxAttempts: 3,
      retryDelayMs: 1000
    });
  });

  test("should allow direct transfer and fallback to be disabled independently", async () => {
    process.env.DIRECT_TRANSFER_ENABLED = "false";
    process.env.DIRECT_TRANSFER_FALLBACK_TO_LOCAL = "false";
    process.env.DIRECT_TRANSFER_TIMEOUT_MS = "12345";
    process.env.DIRECT_TRANSFER_STALL_TIMEOUT_MS = "6789";

    __resetConfigForTests();
    const config = await initConfig();

    expect(config.directTransfer).toEqual({
      enabled: false,
      fallbackToLocal: false,
      timeoutMs: 12345,
      stallTimeoutMs: 6789,
      maxAttempts: 3,
      retryDelayMs: 1000
    });

    delete process.env.DIRECT_TRANSFER_ENABLED;
    delete process.env.DIRECT_TRANSFER_FALLBACK_TO_LOCAL;
    delete process.env.DIRECT_TRANSFER_TIMEOUT_MS;
    delete process.env.DIRECT_TRANSFER_STALL_TIMEOUT_MS;
  });

  test("should parse boolean env values case-insensitively", async () => {
    process.env.DIRECT_TRANSFER_ENABLED = "FALSE";
    process.env.DIRECT_TRANSFER_FALLBACK_TO_LOCAL = " 0 ";
    process.env.DB_AUTO_MIGRATE = "YES";
    process.env.DB_SCHEMA_CHECK = "On";
    process.env.STREAM_FORWARDING_ENABLED = "ON";
    process.env.INSTANCE_SECRET = "shared-secret";

    __resetConfigForTests();
    const config = await initConfig();

    expect(config.directTransfer).toMatchObject({
      enabled: false,
      fallbackToLocal: false
    });
    expect(config.database).toMatchObject({
      autoMigrate: true,
      schemaCheck: true
    });
    expect(config.streamForwarding.enabled).toBe(true);

    delete process.env.DIRECT_TRANSFER_ENABLED;
    delete process.env.DIRECT_TRANSFER_FALLBACK_TO_LOCAL;
    delete process.env.DB_AUTO_MIGRATE;
    delete process.env.DB_SCHEMA_CHECK;
    delete process.env.STREAM_FORWARDING_ENABLED;
    delete process.env.INSTANCE_SECRET;
  });
});
