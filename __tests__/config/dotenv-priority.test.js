// Mock the dotenv.js module which is what config/index.js imports
const mockLoadDotenv = vi.fn();
vi.mock('../../src/config/dotenv.js', () => ({
   loadDotenv: mockLoadDotenv,
   default: {
     config: mockLoadDotenv
   }
}));

describe("dotenv priority in config", () => {
  let originalNodeEnv;
  let originalDotenvOverride;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockLoadDotenv.mockClear();
    
    originalNodeEnv = process.env.NODE_ENV;
    originalDotenvOverride = process.env.DOTENV_OVERRIDE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }

    if (originalDotenvOverride !== undefined) {
      process.env.DOTENV_OVERRIDE = originalDotenvOverride;
    } else {
      delete process.env.DOTENV_OVERRIDE;
    }
  });

  test("should override system env with .env in non-test environment", async () => {
    process.env.NODE_ENV = 'development';

    await import('../../src/config/index.js');

    expect(mockLoadDotenv).toHaveBeenCalledWith(
      expect.objectContaining({
        override: true,
        path: '.env'
      })
    );
  });

  test("should not override system env in production by default", async () => {
    process.env.NODE_ENV = 'production';

    await import('../../src/config/index.js');

    expect(mockLoadDotenv).toHaveBeenCalledWith(
      expect.objectContaining({
        override: false,
        path: '.env.prod'
      })
    );
  });

  test("should allow overriding system env in production when DOTENV_OVERRIDE=true", async () => {
    process.env.NODE_ENV = 'production';
    process.env.DOTENV_OVERRIDE = 'true';

    await import('../../src/config/index.js');

    expect(mockLoadDotenv).toHaveBeenCalledWith(
      expect.objectContaining({
        override: true,
        path: '.env.prod'
      })
    );
  });

  test("should not override system env in test environment", async () => {
    process.env.NODE_ENV = 'test';

    await import('../../src/config/index.js');

    expect(mockLoadDotenv).toHaveBeenCalledWith(
      expect.objectContaining({
        override: false,
        path: '.env.test'
      })
    );
  });
});
