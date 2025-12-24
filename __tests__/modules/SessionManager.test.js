import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// Mock d1 service
jest.unstable_mockModule("../../src/services/d1.js", () => ({
  d1: {
    fetchOne: jest.fn(),
    run: jest.fn(),
  },
}));

const { SessionManager } = await import("../../src/modules/SessionManager.js");
const { d1 } = await import("../../src/services/d1.js");

describe("SessionManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should have the required static methods", () => {
    expect(typeof SessionManager.get).toBe("function");
    expect(typeof SessionManager.start).toBe("function");
    expect(typeof SessionManager.update).toBe("function");
    expect(typeof SessionManager.clear).toBe("function");
  });

  describe("get", () => {
    test("should retrieve a session", async () => {
      const userId = "user123";
      const mockSession = { user_id: userId, current_step: "STEP1", temp_data: "{}" };
      d1.fetchOne.mockResolvedValue(mockSession);

      const session = await SessionManager.get(userId);

      expect(d1.fetchOne).toHaveBeenCalledWith("SELECT * FROM sessions WHERE user_id = ?", [userId]);
      expect(session).toEqual(mockSession);
    });

    test("should return null if no session found", async () => {
      const userId = "user123";
      d1.fetchOne.mockResolvedValue(null);

      const session = await SessionManager.get(userId);

      expect(session).toBeNull();
    });
  });

  describe("start", () => {
    test("should insert a new session", async () => {
      const userId = "user123";
      const step = "NEW_STEP";
      const data = { some: "data" };

      await SessionManager.start(userId, step, data);

      expect(d1.run).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO sessions"),
        [userId, step, JSON.stringify(data), expect.any(Number)]
      );
    });

    test("should update an existing session if user_id conflicts", async () => {
      const userId = "user123";
      const step = "UPDATED_STEP";
      const data = { new: "data" };

      await SessionManager.start(userId, step, data);

      expect(d1.run).toHaveBeenCalledWith(
        expect.stringContaining("ON CONFLICT(user_id) DO UPDATE SET"),
        [userId, step, JSON.stringify(data), expect.any(Number)]
      );
    });
  });

  describe("update", () => {
    test("should update an existing session", async () => {
      const userId = "user123";
      const oldStep = "OLD_STEP";
      const oldData = { initial: "value" };
      const newStep = "LATER_STEP";
      const newData = { updated: "value" };
      const mockSession = { user_id: userId, current_step: oldStep, temp_data: JSON.stringify(oldData) };

      d1.fetchOne.mockResolvedValue(mockSession);

      await SessionManager.update(userId, newStep, newData);

      const mergedData = { ...oldData, ...newData };
      expect(d1.run).toHaveBeenCalledWith(
        "UPDATE sessions SET current_step = ?, temp_data = ?, updated_at = ? WHERE user_id = ?",
        [newStep, JSON.stringify(mergedData), expect.any(Number), userId]
      );
    });

    test("should return undefined if session does not exist", async () => {
      const userId = "user123";
      d1.fetchOne.mockResolvedValue(null);

      const result = await SessionManager.update(userId, "STEP", {});

      expect(d1.fetchOne).toHaveBeenCalledWith("SELECT * FROM sessions WHERE user_id = ?", [userId]);
      expect(d1.run).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  describe("clear", () => {
    test("should delete a session", async () => {
      const userId = "user123";

      await SessionManager.clear(userId);

      expect(d1.run).toHaveBeenCalledWith("DELETE FROM sessions WHERE user_id = ?", [userId]);
    });
  });
});