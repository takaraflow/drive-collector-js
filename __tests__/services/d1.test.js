import { d1 } from "../../src/services/d1.js";

describe("D1 Service", () => {
  test("should initialize the D1 service", () => {
    expect(d1).toBeDefined();
  });

  test("should have the correct service type", () => {
    expect(d1.constructor.name).toBe("D1Service");
  });

  test("should have the required methods", () => {
    expect(typeof d1._execute).toBe("function");
    expect(typeof d1.fetchAll).toBe("function");
    expect(typeof d1.fetchOne).toBe("function");
    expect(typeof d1.run).toBe("function");
    expect(typeof d1.batch).toBe("function");
  });
});