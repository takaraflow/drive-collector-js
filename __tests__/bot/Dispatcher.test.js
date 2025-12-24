import { jest, describe, test, expect } from "@jest/globals";

// Mock all dependencies of Dispatcher
jest.unstable_mockModule("../../src/config/index.js", () => ({
  config: {
    ownerId: "mock_owner_id",
  },
}));

jest.unstable_mockModule("../../src/services/telegram.js", () => ({
  client: {},
}));

jest.unstable_mockModule("../../src/modules/AuthGuard.js", () => ({
  AuthGuard: {
    isMaintainer: jest.fn(),
    isOwner: jest.fn(),
  },
}));

jest.unstable_mockModule("../../src/modules/SessionManager.js", () => ({
  SessionManager: {
    get: jest.fn(),
  },
}));

// Import the module to be tested dynamically
const { Dispatcher } = await import("../../src/bot/Dispatcher.js");

describe("Dispatcher", () => {
  test("should have the required static methods", () => {
    expect(typeof Dispatcher.handle).toBe("function");
    expect(typeof Dispatcher._extractContext).toBe("function");
    expect(typeof Dispatcher._globalGuard).toBe("function");
    expect(typeof Dispatcher._handleCallback).toBe("function");
    expect(typeof Dispatcher._handleMessage).toBe("function");
  });

  test("should have the required static properties", () => {
    expect(Dispatcher.groupBuffers).toBeInstanceOf(Map);
    expect(Dispatcher.lastRefreshTime).toBe(0);
  });
});