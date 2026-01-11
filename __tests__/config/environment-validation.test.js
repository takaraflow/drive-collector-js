import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { initConfig, __resetConfigForTests } from "../../src/config/index.js";

// Mock dependencies at top level
await jest.unstable_mockModule('dotenv', () => ({
  default: {
    config: jest.fn(() => ({ parsed: {} }))
  },
  loadDotenv: jest.fn()
}));

await jest.unstable_mockModule('../../src/services/InfisicalClient.js', () => ({
  fetchInfisicalSecrets: jest.fn().mockResolvedValue({})
}));

const originalEnv = { ...process.env };

describe("config - Environment Validation", () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.SKIP_INFISICAL_RUNTIME = "true";
    __resetConfigForTests();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
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
      expect(process.env.NODE_ENV).toBe("prod");
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
      expect(process.env.NODE_ENV).toBe("pre");
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
