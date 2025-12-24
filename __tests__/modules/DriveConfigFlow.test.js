import { jest, describe, test, expect } from "@jest/globals";

// Mock dependencies to prevent real network calls or database access
jest.unstable_mockModule("../../src/services/telegram.js", () => ({
  client: {
    sendMessage: jest.fn(),
    editMessage: jest.fn(),
  },
}));

jest.unstable_mockModule("../../src/repositories/DriveRepository.js", () => ({
  DriveRepository: {
    findByUserId: jest.fn(),
  },
}));

jest.unstable_mockModule("../../src/modules/SessionManager.js", () => ({
  SessionManager: {
    start: jest.fn(),
    update: jest.fn(),
  },
}));

// We need to dynamically import the module after setting up the mocks
const { DriveConfigFlow } = await import(
  "../../src/modules/DriveConfigFlow.js"
);

describe("DriveConfigFlow", () => {
  test("should have the required static methods", () => {
    expect(typeof DriveConfigFlow.sendDriveManager).toBe("function");
    expect(typeof DriveConfigFlow.handleCallback).toBe("function");
    expect(typeof DriveConfigFlow.handleInput).toBe("function");
  });

  test("should have the correct supported drives", () => {
    expect(DriveConfigFlow.SUPPORTED_DRIVES).toBeDefined();
    expect(Array.isArray(DriveConfigFlow.SUPPORTED_DRIVES)).toBe(true);
    expect(DriveConfigFlow.SUPPORTED_DRIVES[0].type).toBe("mega");
  });
});