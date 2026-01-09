import { describe, test, expect, beforeEach, afterEach, jest } from "@jest/globals";

const originalEnv = process.env;

describe("sync-env script", () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = {
      ...originalEnv,
      INFISICAL_TOKEN: "test-token",
      INFISICAL_PROJECT_ID: "test-project",
      STRICT_SYNC: "false"
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  test("should skip local .env fallback when Infisical sync succeeds", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    const fsMock = {
      existsSync: jest.fn((targetPath) => !targetPath.endsWith("manifest.json")),
      readFileSync: jest.fn(),
      writeFileSync: jest.fn()
    };

    const dotenvMock = {
      config: jest.fn(),
      parse: jest.fn()
    };

    const listSecretsMock = jest.fn().mockResolvedValue({
      secrets: [{ secretKey: "API_ID", secretValue: "12345" }]
    });

    class MockInfisicalSDK {
      auth() {
        return { accessToken: jest.fn() };
      }
      secrets() {
        return { listSecrets: listSecretsMock };
      }
    }

    await jest.unstable_mockModule("fs", () => ({ default: fsMock }));
    await jest.unstable_mockModule("dotenv", () => ({ default: dotenvMock }));
    await jest.unstable_mockModule("@infisical/sdk", () => ({ InfisicalSDK: MockInfisicalSDK }));

    let importError;
    try {
      const { syncEnv } = await import("../../scripts/sync-env.js");
      await syncEnv();
    } catch (err) {
      importError = err;
    }

    expect(importError).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).toHaveBeenCalled();

    const logText = logSpy.mock.calls.flat().join(" ");
    expect(logText).toContain("使用 Infisical 变量继续");
    expect(logText).not.toContain("本地 .env");

    const warnText = warnSpy.mock.calls.flat().join(" ");
    if (warnText.length > 0) {
      expect(warnText).toContain("未找到 manifest.json");
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
