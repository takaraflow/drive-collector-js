import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { initConfig, __resetConfigForTests } from "../../src/config/index.js";

const originalEnv = { ...process.env };

describe("config - Environment Validation", () => {
  beforeEach(async () => {
    // 重置环境
    process.env = { ...originalEnv };
    process.env.SKIP_INFISICAL_RUNTIME = "true";
    
    // Mock console
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    
    __resetConfigForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("Environment Consistency Validation", () => {
    test("should allow matching NODE_ENV and INFISICAL_ENV", async () => {
      process.env.NODE_ENV = "prod";
      process.env.INFISICAL_ENV = "prod";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";
      process.env.API_ID = "12345";
      process.env.API_HASH = "test_hash";
      process.env.BOT_TOKEN = "test_bot_token";
      process.env.OWNER_ID = "owner_id";

      const config = await initConfig();
      expect(config).toBeDefined();
    });

    test("should accept all valid environment names", async () => {
      const validEnvs = ["dev", "pre", "prod"];

      for (const env of validEnvs) {
        __resetConfigForTests();
        process.env.NODE_ENV = env;
        process.env.INFISICAL_ENV = env;
        process.env.INFISICAL_TOKEN = "test_token";
        process.env.INFISICAL_PROJECT_ID = "test_project";
        process.env.API_ID = "12345";
        process.env.API_HASH = "test_hash";
        process.env.BOT_TOKEN = "test_bot_token";
        process.env.OWNER_ID = "owner_id";

        const config = await initConfig();
        expect(config).toBeDefined();
      }
    });
  });

  describe("Environment Normalization", () => {
    test("should normalize production to prod in initConfig", async () => {
      process.env.NODE_ENV = "production";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";
      process.env.API_ID = "12345";
      process.env.API_HASH = "test_hash";
      process.env.BOT_TOKEN = "test_bot_token";
      process.env.OWNER_ID = "owner_id";

      const config = await initConfig();
      expect(config).toBeDefined();
    });

    test("should normalize staging to pre in initConfig", async () => {
      process.env.NODE_ENV = "staging";
      process.env.INFISICAL_ENV = "pre";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";
      process.env.API_ID = "12345";
      process.env.API_HASH = "test_hash";
      process.env.BOT_TOKEN = "test_bot_token";
      process.env.OWNER_ID = "owner_id";

      const config = await initConfig();
      expect(config).toBeDefined();
    });
  });

  describe("Error Handling", () => {
    test("should handle validation errors gracefully", async () => {
      process.env.NODE_ENV = "prod";
      process.env.INFISICAL_ENV = "dev";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";
      process.env.API_ID = "12345";
      process.env.API_HASH = "test_hash";
      process.env.BOT_TOKEN = "test_bot_token";
      process.env.OWNER_ID = "owner_id";

      await expect(initConfig()).rejects.toThrow();
    });

    test("should allow other validation errors to proceed in non-prod", async () => {
      process.env.NODE_ENV = "dev";
      process.env.INFISICAL_ENV = "pre";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";
      process.env.API_ID = "12345";
      process.env.API_HASH = "test_hash";
      process.env.BOT_TOKEN = "test_bot_token";
      process.env.OWNER_ID = "owner_id";

      const config = await initConfig();
      expect(config).toBeDefined();
    });
  });
});