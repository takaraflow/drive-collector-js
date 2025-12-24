import { DriveConfigFlow } from "../../src/modules/DriveConfigFlow.js";

describe("DriveConfigFlow", () => {
  test("should have the required static methods", () => {
    expect(typeof DriveConfigFlow.sendDriveManager).toBe("function");
    expect(typeof DriveConfigFlow.handleCallback).toBe("function");
    expect(typeof DriveConfigFlow.handleInput).toBe("function");
  });

  test("should have the correct supported drives", () => {
    expect(DriveConfigFlow.SUPPORTED_DRIVES).toBeDefined();
    expect(Array.isArray(DriveConfigFlow.SUPPORTED_DRIVES)).toBe(true);
  });
});