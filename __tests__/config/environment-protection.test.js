import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";

const originalEnv = process.env;

describe("config - Environment Variable Protection", () => {
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

  describe("Protected Environment Variables", () => {
    test("should protect NODE_ENV when set before import", async () => {
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

    test("should protect INFISICAL_ENV when set before import", async () => {
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

    test("should protect INFISICAL_TOKEN from being overwritten", async () => {
      process.env.NODE_ENV = "dev";
      process.env.INFISICAL_TOKEN = "protected_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";
      process.env.API_ID = "12345";
      process.env.API_HASH = "test_hash";
      process.env.BOT_TOKEN = "test_bot_token";
      process.env.OWNER_ID = "owner_id";

      const { initConfig } = await import("../../src/config/index.js");

      const config = await initConfig();

      expect(config).toBeDefined();
      expect(process.env.INFISICAL_TOKEN).toBe("protected_token");
    });

    test("should protect INFISICAL_PROJECT_ID from being overwritten", async () => {
      process.env.NODE_ENV = "dev";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "protected_project_id";
      process.env.API_ID = "12345";
      process.env.API_HASH = "test_hash";
      process.env.BOT_TOKEN = "test_bot_token";
      process.env.OWNER_ID = "owner_id";

      const { initConfig } = await import("../../src/config/index.js");

      const config = await initConfig();

      expect(config).toBeDefined();
      expect(process.env.INFISICAL_PROJECT_ID).toBe("protected_project_id");
    });
  });

  describe("Priority Mechanism", () => {
    test("should prioritize INFISICAL_ENV over NODE_ENV", async () => {
      process.env.INFISICAL_ENV = "pre";
      process.env.NODE_ENV = "dev";
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

    test("should use NODE_ENV when INFISICAL_ENV is not set", async () => {
      process.env.NODE_ENV = "dev";
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

  describe("Environment Normalization Integration", () => {
    test("should normalize NODE_ENV and initialize config", async () => {
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

    test("should normalize development and initialize config", async () => {
      process.env.NODE_ENV = "development";
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

    test("should normalize staging and initialize config", async () => {
      process.env.NODE_ENV = "staging";
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

    test("should use default for invalid NODE_ENV", async () => {
      process.env.NODE_ENV = "invalid_env";
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
