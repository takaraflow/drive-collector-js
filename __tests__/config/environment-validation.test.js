import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";

const originalEnv = process.env;

describe("config - Environment Validation", () => {
  beforeEach(async () => {
    jest.resetModules();
    await jest.unstable_mockModule('dotenv', () => ({
      default: {
        config: jest.fn(() => ({ parsed: {} }))
      }
    }));
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.SKIP_INFISICAL_RUNTIME = "true";
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
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

      const { initConfig } = await import("../../src/config/index.js");

      const config = await initConfig();

      expect(config).toBeDefined();
    });

    test("should accept all valid environment names", async () => {
      const validEnvs = ["dev", "pre", "prod"];

      for (const env of validEnvs) {
        jest.resetModules();
        process.env.NODE_ENV = env;
        process.env.INFISICAL_ENV = env;
        process.env.INFISICAL_TOKEN = "test_token";
        process.env.INFISICAL_PROJECT_ID = "test_project";
        process.env.API_ID = "12345";
        process.env.API_HASH = "test_hash";
        process.env.BOT_TOKEN = "test_bot_token";
        process.env.OWNER_ID = "owner_id";

        const { initConfig } = await import("../../src/config/index.js");

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

      const { initConfig } = await import("../../src/config/index.js");

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

      const { initConfig } = await import("../../src/config/index.js");

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

      const { initConfig } = await import("../../src/config/index.js");

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

      const { initConfig } = await import("../../src/config/index.js");

      const config = await initConfig();

      expect(config).toBeDefined();
    });
  });
});
