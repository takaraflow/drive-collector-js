const originalEnv = process.env;

describe("sync-env script", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = {
      ...originalEnv,
      INFISICAL_TOKEN: "test-token",
      INFISICAL_PROJECT_ID: "test-project",
      STRICT_SYNC: "false",
      SYNC_ENV_WRITE_FILE: "false"
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  test("should load remote secrets without writing them to disk by default", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    const fsMock = {
      existsSync: vi.fn((targetPath) => !targetPath.endsWith("manifest.json")),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn()
    };

    const dotenvMock = {
      config: vi.fn(),
      parse: vi.fn()
    };

    const listSecretsMock = vi.fn().mockResolvedValue({
      secrets: [{ secretKey: "API_ID", secretValue: "12345" }]
    });

    class MockInfisicalSDK {
      auth() {
        return { accessToken: vi.fn() };
      }
      secrets() {
        return { listSecrets: listSecretsMock };
      }
    }

    await vi.doMock("fs", () => ({ default: fsMock }));
    await vi.doMock("dotenv", () => ({ default: dotenvMock }));
    await vi.doMock("@infisical/sdk", () => ({ InfisicalSDK: MockInfisicalSDK }));

    let importError;
    try {
      const { syncEnv } = await import("../../scripts/sync-env.js");
      await syncEnv();
    } catch (err) {
      importError = err;
    }

    expect(importError).toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
    expect(process.env.API_ID).toBe("12345");

    const logText = logSpy.mock.calls.flat().join(" ");
    expect(logText).toContain("使用 Infisical 变量继续");
    expect(logText).toContain("未写入 .env 文件");
    expect(logText).not.toContain("本地 .env");

    const warnText = warnSpy.mock.calls.flat().join(" ");
    if (warnText.length > 0) {
      expect(warnText).toContain("未找到 manifest.json");
    }
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("should only write remote secrets when explicitly enabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    process.env.SYNC_ENV_WRITE_FILE = "true";

    const fsMock = {
      existsSync: vi.fn((targetPath) => !targetPath.endsWith("manifest.json")),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn()
    };

    const dotenvMock = {
      config: vi.fn(),
      parse: vi.fn()
    };

    class MockInfisicalSDK {
      auth() {
        return { accessToken: vi.fn() };
      }
      secrets() {
        return {
          listSecrets: vi.fn().mockResolvedValue({
            secrets: [{ secretKey: "API_ID", secretValue: "12345" }]
          })
        };
      }
    }

    await vi.doMock("fs", () => ({ default: fsMock }));
    await vi.doMock("dotenv", () => ({ default: dotenvMock }));
    await vi.doMock("@infisical/sdk", () => ({ InfisicalSDK: MockInfisicalSDK }));

    const { syncEnv } = await import("../../scripts/sync-env.js");
    await syncEnv();

    expect(exitSpy).not.toHaveBeenCalled();
    expect(fsMock.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining(".env"),
      expect.stringContaining("API_ID=12345"),
      { mode: 0o600 }
    );
  });
});
