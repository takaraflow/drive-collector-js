import { STRINGS } from "../../src/locales/zh-CN.js";

describe("zh-CN Locale", () => {
  test("should have the required strings", () => {
    expect(STRINGS).toBeDefined();
    expect(typeof STRINGS).toBe("object");
  });

  test("should have system strings", () => {
    expect(STRINGS.system).toBeDefined();
    expect(typeof STRINGS.system).toBe("object");
  });

  test("should have task strings", () => {
    expect(STRINGS.task).toBeDefined();
    expect(typeof STRINGS.task).toBe("object");
  });

  test("should have drive strings", () => {
    expect(STRINGS.drive).toBeDefined();
    expect(typeof STRINGS.drive).toBe("object");
  });
});