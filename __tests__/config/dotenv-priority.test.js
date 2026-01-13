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

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockLoadDotenv.mockClear();
    
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
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