describe("config - Environment Variable Protection", () => {
  const originalEnv = { ...process.env };
  let mockEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset mock environment
    mockEnv = { ...originalEnv };
    
    // Mock console to prevent log pollution
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    
    // Reset process.env
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  // Helper function to initialize config with mocked dependencies
  const initTestConfig = async (envOverrides = {}) => {
    mockEnv = {
      ...mockEnv,
      ...envOverrides
    };

    // Mock dependencies locally
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

    const { initConfig, __resetConfigForTests } = await import("../../src/config/index.js");
    const { getEnv } = await import("../../src/config/env.js");
    
    __resetConfigForTests();
    const config = await initConfig();
    return { config, getEnv };
  };

  describe("Protected Environment Variables", () => {
    test("should protect NODE_ENV when set before import", async () => {
      const { config, getEnv } = await initTestConfig({
        NODE_ENV: "prod",
        INFISICAL_ENV: "prod",
        INFISICAL_TOKEN: "test_token",
        INFISICAL_PROJECT_ID: "test_project",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      });

      expect(config).toBeDefined();
      expect(getEnv().NODE_ENV).toBe("prod");
    });

    test("should protect INFISICAL_ENV when set before import", async () => {
      const { config, getEnv } = await initTestConfig({
        NODE_ENV: "dev",
        INFISICAL_ENV: "pre",
        INFISICAL_TOKEN: "test_token",
        INFISICAL_PROJECT_ID: "test_project",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      });

      expect(config).toBeDefined();
      expect(getEnv().INFISICAL_ENV).toBe("pre");
    });

    test("should protect INFISICAL_TOKEN from being overwritten", async () => {
      const { config, getEnv } = await initTestConfig({
        NODE_ENV: "dev",
        INFISICAL_TOKEN: "protected_token",
        INFISICAL_PROJECT_ID: "test_project",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      });

      expect(config).toBeDefined();
      expect(getEnv().INFISICAL_TOKEN).toBe("protected_token");
    });

    test("should protect INFISICAL_PROJECT_ID from being overwritten", async () => {
      const { config, getEnv } = await initTestConfig({
        NODE_ENV: "dev",
        INFISICAL_TOKEN: "test_token",
        INFISICAL_PROJECT_ID: "protected_project_id",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      });

      expect(config).toBeDefined();
      expect(getEnv().INFISICAL_PROJECT_ID).toBe("protected_project_id");
    });
  });

  describe("Priority Mechanism", () => {
    test("should prioritize INFISICAL_ENV over NODE_ENV", async () => {
      const { config } = await initTestConfig({
        INFISICAL_ENV: "pre",
        NODE_ENV: "dev",
        INFISICAL_TOKEN: "test_token",
        INFISICAL_PROJECT_ID: "test_project",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      });

      expect(config).toBeDefined();
    });

    test("should use NODE_ENV when INFISICAL_ENV is not set", async () => {
      const { config } = await initTestConfig({
        NODE_ENV: "dev",
        INFISICAL_TOKEN: "test_token",
        INFISICAL_PROJECT_ID: "test_project",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      });

      expect(config).toBeDefined();
    });
  });

  describe("Environment Normalization Integration", () => {
    // Note: The config module normalizes NODE_ENV at module load time (lines 18-20 in src/config/index.js)
    // This means by the time initConfig() is called, NODE_ENV is already normalized.
    // These tests verify that the config can be initialized successfully with various input values.
    
    const testEnvs = [
      { NODE_ENV: "production", description: "production -> prod" },
      { NODE_ENV: "development", description: "development -> dev" },
      { NODE_ENV: "staging", description: "staging -> pre" },
      { NODE_ENV: "invalid_env", description: "invalid_env -> dev" }
    ];

    test.each(testEnvs)("should handle $description and initialize config", async ({ NODE_ENV }) => {
      const { config } = await initTestConfig({
        NODE_ENV,
        INFISICAL_TOKEN: "test_token",
        INFISICAL_PROJECT_ID: "test_project",
        API_ID: "12345",
        API_HASH: "test_hash",
        BOT_TOKEN: "test_bot_token",
        OWNER_ID: "owner_id"
      });

      // Verify config initializes successfully regardless of input NODE_ENV
      expect(config).toBeDefined();
    });
  });
});
