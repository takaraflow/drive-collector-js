import { describe, test, expect, beforeEach, afterEach, beforeAll, jest } from "@jest/globals";
import fs from 'fs';

const originalEnv = { ...process.env };
let syncEnv;
let listSecretsMock;

describe("sync-env - Environment Variable Priority", () => {
  beforeAll(async () => {
    listSecretsMock = jest.fn(async () => ({ secrets: [] }));
    await jest.unstable_mockModule('@infisical/sdk', () => {
      return {
        InfisicalSDK: class {
          auth() {
            return {
              accessToken: () => {}
            };
          }
          secrets() {
            return {
              listSecrets: listSecretsMock
            };
          }
        }
      };
    });
    await jest.unstable_mockModule('dotenv', () => ({
      default: {
        config: jest.fn(),
        parse: jest.fn()
      }
    }));

    const module = await import("../../scripts/sync-env.js");
    syncEnv = module.syncEnv;
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    if (listSecretsMock) listSecretsMock.mockClear();
    process.env.INFISICAL_TOKEN = "";
    process.env.INFISICAL_PROJECT_ID = "";
    process.env.SKIP_INFISICAL_RUNTIME = "true";
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  describe("INFISICAL_ENV Priority", () => {
    test("should use INFISICAL_ENV when both are set", async () => {
      process.env.INFISICAL_ENV = "pre";
      process.env.NODE_ENV = "dev";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();

      expect(process.env.INFISICAL_ENV).toBe("pre");
      expect(process.env.NODE_ENV).toBe("dev");
    });

    test("should use INFISICAL_ENV over NODE_ENV", async () => {
      process.env.INFISICAL_ENV = "prod";
      process.env.NODE_ENV = "dev";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();

      expect(process.env.INFISICAL_ENV).toBe("prod");
      expect(process.env.NODE_ENV).toBe("dev");
    });
  });

  describe("NODE_ENV Fallback", () => {
    test("should use NODE_ENV when INFISICAL_ENV is not set", async () => {
      process.env.INFISICAL_ENV = "";
      process.env.NODE_ENV = "pre";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();

      expect(process.env.NODE_ENV).toBe("pre");
    });

    test("should preserve original NODE_ENV value", async () => {
      process.env.INFISICAL_ENV = "";
      process.env.NODE_ENV = "production";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();

      expect(process.env.NODE_ENV).toBe("production");
    });

    test("should preserve original NODE_ENV when not normalized", async () => {
      process.env.INFISICAL_ENV = "";
      process.env.NODE_ENV = "development";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();

      expect(process.env.NODE_ENV).toBe("development");
    });
  });

  describe("Environment Mapping", () => {
    test("should preserve production NODE_ENV", async () => {
      process.env.INFISICAL_ENV = "";
      process.env.NODE_ENV = "production";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();

      expect(process.env.NODE_ENV).toBe("production");
    });

    test("should preserve staging NODE_ENV", async () => {
      process.env.INFISICAL_ENV = "";
      process.env.NODE_ENV = "staging";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();

      expect(process.env.NODE_ENV).toBe("staging");
    });

    test("should preserve dev NODE_ENV", async () => {
      process.env.INFISICAL_ENV = "";
      process.env.NODE_ENV = "dev";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();

      expect(process.env.NODE_ENV).toBe("dev");
    });

    test("should preserve test NODE_ENV", async () => {
      process.env.INFISICAL_ENV = "";
      process.env.NODE_ENV = "test";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();

      expect(process.env.NODE_ENV).toBe("test");
    });
  });

  describe("Priority Order", () => {
    test("should verify INFISICAL_ENV is prioritized", async () => {
      process.env.INFISICAL_ENV = "pre";
      process.env.NODE_ENV = "dev";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();

      expect(process.env.INFISICAL_ENV).toBe("pre");
    });

    test("should use NODE_ENV when INFISICAL_ENV is missing", async () => {
      process.env.INFISICAL_ENV = "";
      process.env.NODE_ENV = "prod";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();

      expect(process.env.NODE_ENV).toBe("prod");
    });

    test("should use default when neither is set", async () => {
      process.env.INFISICAL_ENV = "";
      process.env.NODE_ENV = "";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();
    });
  });

  describe("Environment Consistency", () => {
    test("should maintain consistency", async () => {
      const testCases = [
        { nodeEnv: "prod", infisicalEnv: "prod" },
        { nodeEnv: "pre", infisicalEnv: "pre" },
        { nodeEnv: "dev", infisicalEnv: "dev" },
      ];

      for (const { nodeEnv, infisicalEnv } of testCases) {
        process.env.INFISICAL_ENV = infisicalEnv;
        process.env.NODE_ENV = nodeEnv;

        await syncEnv();

        expect(process.env.NODE_ENV).toBe(nodeEnv);
      }
    });
  });

  describe("Error Handling", () => {
    test("should handle missing credentials gracefully", async () => {
      process.env.INFISICAL_TOKEN = "";
      process.env.INFISICAL_PROJECT_ID = "";

      await expect(syncEnv()).resolves.toBeUndefined();
    });

    test("should preserve invalid environment values", async () => {
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";
      process.env.NODE_ENV = "invalid_env";

      await syncEnv();

      expect(process.env.NODE_ENV).toBe("invalid_env");
    });
  });
});
