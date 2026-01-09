import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";

describe("dotenv priority in config", () => {
  let originalProcessEnv;
  let mockDotEnvConfig;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    
    // Save original process.env
    originalProcessEnv = { ...process.env };
    
    // Mock dotenv
    mockDotEnvConfig = jest.fn();
    
    // Mock dotenv module before any imports
    jest.mock('dotenv', () => ({
      config: mockDotEnvConfig
    }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
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

    // Verify dotenv was called with override: true for non-test env
    expect(mockDotEnvConfig).toHaveBeenCalledWith(
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

    // Reset mock for clean test
    mockDotEnvConfig.mockClear();

    // Import config module
    const config = await import('../../src/config/index.js');

    // Verify dotenv was called with override: false for test env
    expect(mockDotEnvConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        override: false,
        path: '.env.test'
      })
    );
  });
});