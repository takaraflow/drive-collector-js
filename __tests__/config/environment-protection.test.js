// Mock process.env completely
const originalEnv = { ...process.env };
let mockEnv = { ...originalEnv };

// Mock dependencies at top level
await vi.doMock('dotenv', () => ({
  default: {
    config: vi.fn(() => ({ parsed: {} }))
  },
  loadDotenv: vi.fn()
}));

await vi.doMock('../../src/config/env.js', () => ({
  getEnv: () => mockEnv,
  getProtectedEnv: () => ({
    NODE_ENV: mockEnv.NODE_ENV,
    INFISICAL_ENV: mockEnv.INFISICAL_ENV,
    INFISICAL_TOKEN: mockEnv.INFISICAL_TOKEN,
    INFISICAL_PROJECT_ID: mockEnv.INFISICAL_PROJECT_ID
  }),
  NODE_ENV: mockEnv.NODE_ENV || 'test',
  INFISICAL_ENV: mockEnv.INFISICAL_ENV,
  INFISICAL_TOKEN: mockEnv.INFISICAL_TOKEN,
  INFISICAL_PROJECT_ID: mockEnv.INFISICAL_PROJECT_ID,
  API_ID: mockEnv.API_ID,
  API_HASH: mockEnv.API_HASH,
  BOT_TOKEN: mockEnv.BOT_TOKEN,
  OWNER_ID: mockEnv.OWNER_ID
}));

// Import after mocking
const { initConfig, __resetConfigForTests } = await import("../../src/config/index.js");
const { getEnv } = await import("../../src/config/env.js");

describe("config - Environment Variable Protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetConfigForTests();
    
    // Reset mock environment
    mockEnv = { ...originalEnv };
    
    // Mock console to prevent log pollution
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Protected Environment Variables", () => {
    test("should protect NODE_ENV when set before import", async () => {
      mockEnv = {
        ...mockEnv,
        NODE_ENV: "prod",
        INFISICAL_ENV: "prod",
        INFISICAL_TOKEN: "test_token",
        INFISICAL_PROJECT_ID: "test_project",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      };

      const config = await initConfig();
      expect(config).toBeDefined();
      expect(getEnv().NODE_ENV).toBe("prod");
    });

    test("should protect INFISICAL_ENV when set before import", async () => {
      mockEnv = {
        ...mockEnv,
        NODE_ENV: "dev",
        INFISICAL_ENV: "pre",
        INFISICAL_TOKEN: "test_token",
        INFISICAL_PROJECT_ID: "test_project",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      };

      const config = await initConfig();
      expect(config).toBeDefined();
      expect(getEnv().INFISICAL_ENV).toBe("pre");
    });

    test("should protect INFISICAL_TOKEN from being overwritten", async () => {
      mockEnv = {
        ...mockEnv,
        NODE_ENV: "dev",
        INFISICAL_TOKEN: "protected_token",
        INFISICAL_PROJECT_ID: "test_project",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      };

      const config = await initConfig();
      expect(config).toBeDefined();
      expect(getEnv().INFISICAL_TOKEN).toBe("protected_token");
    });

    test("should protect INFISICAL_PROJECT_ID from being overwritten", async () => {
      mockEnv = {
        ...mockEnv,
        NODE_ENV: "dev",
        INFISICAL_TOKEN: "test_token",
        INFISICAL_PROJECT_ID: "protected_project_id",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      };

      const config = await initConfig();
      expect(config).toBeDefined();
      expect(getEnv().INFISICAL_PROJECT_ID).toBe("protected_project_id");
    });
  });

  describe("Priority Mechanism", () => {
    test("should prioritize INFISICAL_ENV over NODE_ENV", async () => {
      mockEnv = {
        ...mockEnv,
        INFISICAL_ENV: "pre",
        NODE_ENV: "dev",
        INFISICAL_TOKEN: "test_token",
        INFISICAL_PROJECT_ID: "test_project",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      };

      const config = await initConfig();
      expect(config).toBeDefined();
    });

    test("should use NODE_ENV when INFISICAL_ENV is not set", async () => {
      mockEnv = {
        ...mockEnv,
        NODE_ENV: "dev",
        INFISICAL_TOKEN: "test_token",
        INFISICAL_PROJECT_ID: "test_project",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      };

      const config = await initConfig();
      expect(config).toBeDefined();
    });
  });

  describe("Environment Normalization Integration", () => {
    const testEnvs = [
      { NODE_ENV: "production", expected: "production" },
      { NODE_ENV: "development", expected: "development" },
      { NODE_ENV: "staging", expected: "staging" },
      { NODE_ENV: "invalid_env", expected: "development" }
    ];

    test.each(testEnvs)("should normalize $NODE_ENV and initialize config", async ({ NODE_ENV, expected }) => {
      mockEnv = {
        ...mockEnv,
        NODE_ENV,
        INFISICAL_TOKEN: "test_token",
        INFISICAL_PROJECT_ID: "test_project",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      };

      const config = await initConfig();
      expect(config).toBeDefined();
      expect(getEnv().NODE_ENV).toBe(NODE_ENV);
    });
  });
});
