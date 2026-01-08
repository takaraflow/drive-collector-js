import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";

const originalEnv = process.env;

describe("dotenv priority in config", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  test("should override system env with .env in non-test environment", async () => {
    process.env = { ...originalEnv, NODE_ENV: "dev" };
    const configSpy = jest.fn();

    await jest.unstable_mockModule("dotenv", () => ({
      default: { config: configSpy }
    }));

    await import("../../src/config/index.js");
    expect(configSpy).toHaveBeenCalledWith({ override: true });
  });

  test("should not override system env in test environment", async () => {
    process.env = { ...originalEnv, NODE_ENV: "test" };
    const configSpy = jest.fn();

    await jest.unstable_mockModule("dotenv", () => ({
      default: { config: configSpy }
    }));

    await import("../../src/config/index.js");
    expect(configSpy).toHaveBeenCalledWith({ override: false });
  });
});
