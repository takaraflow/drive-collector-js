// Mock the dotenv.js module which is what config/index.js imports
const mockLoadDotenv = vi.fn();
vi.mock('../../src/config/dotenv.js', () => ({
  loadDotenv: mockLoadDotenv,
  default: {
    config: mockLoadDotenv
  }
}));

describe("dotenv priority in config", () => {
  let originalProcessEnv;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockLoadDotenv.mockClear();
    
    // Save original process.env
    originalProcessEnv = { ...process.env };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore process.env
    process.env = originalProcessEnv;
  });

  test("should override system env with .env in non-test environment", async () => {
    // Mock process.env for non-test environment
    process.env = {
      ...originalProcessEnv,
      NODE_ENV: 'development' // Not 'test'
    };

    // Import config module (it will use mocked dotenv)
    const config = await import('../../src/config/index.js');

    // Verify loadDotenv was called with override: true for non-test env
    expect(mockLoadDotenv).toHaveBeenCalledWith(
      expect.objectContaining({
        override: true,
        path: '.env'
      })
    );
  });

  test("should not override system env in test environment", async () => {
    // Mock process.env for test environment
    process.env = {
      ...originalProcessEnv,
      NODE_ENV: 'test'
    };

    // Import config module
    const config = await import('../../src/config/index.js');

    // Verify loadDotenv was called with override: false for test env
    expect(mockLoadDotenv).toHaveBeenCalledWith(
      expect.objectContaining({
        override: false,
        path: '.env.test'
      })
    );
  });
});