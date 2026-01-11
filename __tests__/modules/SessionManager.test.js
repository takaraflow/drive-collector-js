// Mock kv service
vi.mock("../../src/services/CacheService.js", () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

const { SessionManager } = await import("../../src/modules/SessionManager.js");
const { cache: kv } = await import("../../src/services/CacheService.js");

describe("SessionManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
      kv.get.mockResolvedValue(mockSession);

      const session = await SessionManager.get(userId);

      expect(kv.get).toHaveBeenCalledWith(`session:${userId}`, expect.anything(), expect.anything());
      expect(session).toEqual(mockSession);
    });

    test("should return null if no session found", async () => {
      const userId = "user123";
      kv.get.mockResolvedValue(null);

      const session = await SessionManager.get(userId);

      expect(session).toBeNull();
    });
  });

  describe("start", () => {
    test("should set a new session in KV", async () => {
      const userId = "user123";
      const step = "NEW_STEP";
      const data = { some: "data" };

      await SessionManager.start(userId, step, data);

      expect(kv.set).toHaveBeenCalledWith(
        `session:${userId}`,
        expect.objectContaining({
            user_id: userId,
            current_step: step,
            temp_data: JSON.stringify(data)
        }),
        86400
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

      kv.get.mockResolvedValue(mockSession);

      await SessionManager.update(userId, newStep, newData);

      const mergedData = { ...oldData, ...newData };
      expect(kv.set).toHaveBeenCalledWith(
        `session:${userId}`,
        expect.objectContaining({
            current_step: newStep,
            temp_data: JSON.stringify(mergedData)
        }),
        86400
      );
    });

    test("should return undefined if session does not exist", async () => {
      const userId = "user123";
      kv.get.mockResolvedValue(null);

      const result = await SessionManager.update(userId, "STEP", {});

      expect(kv.get).toHaveBeenCalledWith(`session:${userId}`, expect.anything(), expect.anything());
      expect(kv.set).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });
  });

  describe("clear", () => {
    test("should delete a session from KV", async () => {
      const userId = "user123";

      await SessionManager.clear(userId);

      expect(kv.delete).toHaveBeenCalledWith(`session:${userId}`);
    });
  });
});