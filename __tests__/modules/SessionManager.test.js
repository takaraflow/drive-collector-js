import { SessionManager } from "../../src/modules/SessionManager.js";

describe("SessionManager", () => {
  test("should have the required static methods", () => {
    expect(typeof SessionManager.get).toBe("function");
    expect(typeof SessionManager.start).toBe("function");
    expect(typeof SessionManager.update).toBe("function");
    expect(typeof SessionManager.clear).toBe("function");
  });
});