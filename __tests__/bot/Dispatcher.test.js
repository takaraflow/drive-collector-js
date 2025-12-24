import { Dispatcher } from "../../src/bot/Dispatcher.js";

describe("Dispatcher", () => {
  test("should have the required static methods", () => {
    expect(typeof Dispatcher.handle).toBe("function");
    expect(typeof Dispatcher._extractContext).toBe("function");
    expect(typeof Dispatcher._globalGuard).toBe("function");
    expect(typeof Dispatcher._handleCallback).toBe("function");
    expect(typeof Dispatcher._handleMessage).toBe("function");
  });

  test("should have the required static properties", () => {
    expect(Dispatcher.groupBuffers).toBeDefined();
    expect(Dispatcher.lastRefreshTime).toBeDefined();
  });
});