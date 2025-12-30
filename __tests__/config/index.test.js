import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";

// Store original process.env
const originalEnv = process.env;

describe("Config Module", () => {
  beforeAll(() => {
    // Reset modules to ensure config is reloaded
    jest.resetModules();
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
    const { config } = await import("../../src/config/index.js");
    expect(config).toBeDefined();
    expect(typeof config).toBe("object");

    // Check properties
    expect(config.apiId).toBe(12345);
    expect(config.apiHash).toBe("mock_hash");
    expect(config.botToken).toBe("mock_token");
    expect(config.ownerId).toBe("owner_id");
    expect(config.remoteName).toBe("mega_test");
    expect(config.remoteFolder).toBe("/test");
    expect(config.port).toBe("8080");
    
    // Check telegram proxy configuration
    expect(config.telegram).toBeDefined();
    expect(config.telegram.proxy).toBeDefined();
    expect(config.telegram.proxy.host).toBe("proxy.example.com");
    expect(config.telegram.proxy.port).toBe("1080");
    expect(config.telegram.proxy.type).toBe("socks5");
    expect(config.telegram.proxy.username).toBe("proxy_user");
    expect(config.telegram.proxy.password).toBe("proxy_pass");
  });

  test("should have the CACHE_TTL constant", async () => {
    const { CACHE_TTL } = await import("../../src/config/index.js");
    expect(CACHE_TTL).toBeDefined();
    expect(typeof CACHE_TTL).toBe("number");
    expect(CACHE_TTL).toBe(10 * 60 * 1000);
  });
});