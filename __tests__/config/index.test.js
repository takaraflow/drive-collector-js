import { config, CACHE_TTL } from "../../src/config/index.js";

describe("Config Module", () => {
  test("should have the required config object", () => {
    expect(config).toBeDefined();
    expect(typeof config).toBe("object");
  });

  test("should have the required config properties", () => {
    expect(config.apiId).toBeDefined();
    expect(config.apiHash).toBeDefined();
    expect(config.botToken).toBeDefined();
    expect(config.ownerId).toBeDefined();
    expect(config.remoteName).toBeDefined();
    expect(config.remoteFolder).toBeDefined();
    expect(config.downloadDir).toBeDefined();
    expect(config.configPath).toBeDefined();
    expect(config.port).toBeDefined();
  });

  test("should have the CACHE_TTL constant", () => {
    expect(CACHE_TTL).toBeDefined();
    expect(typeof CACHE_TTL).toBe("number");
  });
});