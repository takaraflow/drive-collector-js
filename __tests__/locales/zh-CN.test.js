import { STRINGS } from "../../src/locales/zh-CN.js";

describe("zh-CN Locale", () => {
  test("should have the required strings", () => {
    expect(STRINGS).toBeDefined();
    expect(typeof STRINGS).toBe("object");
  });

  test("should have system strings", () => {
    expect(STRINGS.system).toBeDefined();
    expect(typeof STRINGS.system).toBe("object");
    expect(STRINGS.system.node_service_active).toBeDefined();
  });

  test("should have task strings", () => {
    expect(STRINGS.task).toBeDefined();
    expect(typeof STRINGS.task).toBe("object");
    expect(STRINGS.task.batch_captured).toBeDefined();
  });

  test("should have drive strings", () => {
    expect(STRINGS.drive).toBeDefined();
    expect(typeof STRINGS.drive).toBe("object");
    expect(STRINGS.drive.bind_failed).toBeDefined();
  });

  test("should have files strings", () => {
    expect(STRINGS.files).toBeDefined();
    expect(typeof STRINGS.files).toBe("object");
    expect(STRINGS.files.directory_prefix).toBeDefined();
  });

  test("should have status strings", () => {
    expect(STRINGS.status).toBeDefined();
    expect(typeof STRINGS.status).toBe("object");
    expect(STRINGS.status.header).toBeDefined();
  });
});