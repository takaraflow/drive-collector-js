const originalEnv = process.env;

// 环境映射单元测试 - 不依赖config/index.js的执行时机
describe("envMapper - Unit Tests", () => {
  afterEach(() => {
    process.env = originalEnv;
  });

  describe("normalizeNodeEnv function", () => {
    test("should normalize production to prod", async () => {
      const { normalizeNodeEnv } = await import("../../src/utils/envMapper.js");

      expect(normalizeNodeEnv("production")).toBe("prod");
      expect(normalizeNodeEnv("prod")).toBe("prod");
    });

    test("should normalize development to dev", async () => {
      const { normalizeNodeEnv } = await import("../../src/utils/envMapper.js");

      expect(normalizeNodeEnv("development")).toBe("dev");
      expect(normalizeNodeEnv("dev")).toBe("dev");
    });

    test("should normalize staging to pre", async () => {
      const { normalizeNodeEnv } = await import("../../src/utils/envMapper.js");

      expect(normalizeNodeEnv("staging")).toBe("pre");
      expect(normalizeNodeEnv("pre")).toBe("pre");
    });

    test("should normalize preview to pre", async () => {
      const { normalizeNodeEnv } = await import("../../src/utils/envMapper.js");

      expect(normalizeNodeEnv("preview")).toBe("pre");
    });

    test("should keep test as test", async () => {
      const { normalizeNodeEnv } = await import("../../src/utils/envMapper.js");

      expect(normalizeNodeEnv("test")).toBe("test");
    });

    test("should handle undefined with default dev", async () => {
      const { normalizeNodeEnv } = await import("../../src/utils/envMapper.js");

      expect(normalizeNodeEnv(undefined)).toBe("dev");
      expect(normalizeNodeEnv(null)).toBe("dev");
      expect(normalizeNodeEnv("")).toBe("dev");
    });

    test("should be case insensitive", async () => {
      const { normalizeNodeEnv } = await import("../../src/utils/envMapper.js");

      expect(normalizeNodeEnv("PRODUCTION")).toBe("prod");
      expect(normalizeNodeEnv("Development")).toBe("dev");
      expect(normalizeNodeEnv("Staging")).toBe("pre");
    });

    test("should use default dev for invalid values", async () => {
      const { normalizeNodeEnv } = await import("../../src/utils/envMapper.js");

      expect(normalizeNodeEnv("invalid")).toBe("dev");
      expect(normalizeNodeEnv("random")).toBe("dev");
      expect(normalizeNodeEnv("production123")).toBe("dev");
    });
  });

  describe("mapNodeEnvToInfisicalEnv function", () => {
    test("should map prod to prod", async () => {
      const { mapNodeEnvToInfisicalEnv } = await import("../../src/utils/envMapper.js");

      expect(mapNodeEnvToInfisicalEnv("prod")).toBe("prod");
      expect(mapNodeEnvToInfisicalEnv("production")).toBe("prod");
    });

    test("should map dev to dev", async () => {
      const { mapNodeEnvToInfisicalEnv, normalizeNodeEnv } = await import("../../src/utils/envMapper.js");

      expect(mapNodeEnvToInfisicalEnv(normalizeNodeEnv("dev"))).toBe("dev");
      expect(mapNodeEnvToInfisicalEnv(normalizeNodeEnv("development"))).toBe("dev");
    });

    test("should map pre to pre", async () => {
      const { mapNodeEnvToInfisicalEnv, normalizeNodeEnv } = await import("../../src/utils/envMapper.js");

      expect(mapNodeEnvToInfisicalEnv(normalizeNodeEnv("pre"))).toBe("pre");
      expect(mapNodeEnvToInfisicalEnv(normalizeNodeEnv("staging"))).toBe("pre");
      expect(mapNodeEnvToInfisicalEnv(normalizeNodeEnv("preview"))).toBe("pre");
    });

    test("should map test to dev", async () => {
      const { mapNodeEnvToInfisicalEnv, normalizeNodeEnv } = await import("../../src/utils/envMapper.js");

      expect(mapNodeEnvToInfisicalEnv(normalizeNodeEnv("test"))).toBe("dev");
    });

    test("should handle undefined with default dev", async () => {
      const { mapNodeEnvToInfisicalEnv } = await import("../../src/utils/envMapper.js");

      expect(mapNodeEnvToInfisicalEnv(undefined)).toBe("dev");
      expect(mapNodeEnvToInfisicalEnv("")).toBe("dev");
      expect(mapNodeEnvToInfisicalEnv("null")).toBe("dev");
    });
  });

  describe("Integration tests", () => {
    test("should handle common scenarios", async () => {
      const { normalizeNodeEnv, mapNodeEnvToInfisicalEnv } = await import("../../src/utils/envMapper.js");

      const scenarios = [
        { input: "production", normalized: "prod", expectedInfisical: "prod" },
        { input: "prod", normalized: "prod", expectedInfisical: "prod" },
        { input: "development", normalized: "dev", expectedInfisical: "dev" },
        { input: "dev", normalized: "dev", expectedInfisical: "dev" },
        { input: "staging", normalized: "pre", expectedInfisical: "pre" },
        { input: "pre", normalized: "pre", expectedInfisical: "pre" },
        { input: "preview", normalized: "pre", expectedInfisical: "pre" },
        { input: "test", normalized: "test", expectedInfisical: "dev" },
      ];

      scenarios.forEach(({ input, normalized, expectedInfisical }) => {
        const norm = normalizeNodeEnv(input);
        const actualInfisical = mapNodeEnvToInfisicalEnv(norm);

        expect(norm).toBe(normalized);
        expect(actualInfisical).toBe(expectedInfisical);
      });
    });
  });
});
