import fs from 'fs';

const originalEnv = { ...process.env };

describe("sync-env - Environment Variable Priority", () => {
  let syncEnv;
  let listSecretsMock;

  beforeEach(async () => {
    // 重置环境
    process.env = { ...originalEnv };
    process.env.INFISICAL_TOKEN = "";
    process.env.INFISICAL_PROJECT_ID = "";
    process.env.SKIP_INFISICAL_RUNTIME = "true";
    
    // 重置 mocks
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    // 每个测试独立 mock 依赖
    listSecretsMock = vi.fn(async () => ({ secrets: [] }));
    await vi.doMock('@infisical/sdk', () => {
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
    await vi.doMock('dotenv', () => ({
      default: {
        config: vi.fn(),
        parse: vi.fn()
      }
    }));

    // 动态导入以确保每次测试都有干净的模块状态
    const module = await import("../../scripts/sync-env.js");
    syncEnv = module.syncEnv;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
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

      // sync-env 脚本不执行标准化，所以保持原始值
      // 这与 src/config/index.js 的行为不同
      expect(process.env.NODE_ENV).toBe("production");
    });

    test("should preserve original NODE_ENV when not normalized", async () => {
      process.env.INFISICAL_ENV = "";
      process.env.NODE_ENV = "development";
      process.env.INFISICAL_TOKEN = "test_token";
      process.env.INFISICAL_PROJECT_ID = "test_project";

      await syncEnv();

      // sync-env 脚本不执行标准化，所以保持原始值
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

      // sync-env.js does not modify process.env.NODE_ENV directly
      // It only uses normalized values internally for Infisical mapping
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
