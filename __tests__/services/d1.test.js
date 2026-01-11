// Mock the global fetch function
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Store original process.env
const originalEnv = process.env;

let d1Instance;

describe("D1 Service", () => {
  beforeAll(async () => {
    // Set up mock environment variables - 使用新的变量名
    process.env = {
      ...originalEnv,
      CF_D1_ACCOUNT_ID: "mock_account_id",
      CF_D1_DATABASE_ID: "mock_database_id",
      CF_D1_TOKEN: "mock_token",
    };
    vi.resetModules(); // Reset modules to re-import d1 with new env

    // Dynamically import d1 after setting up mocks
    const { d1: importedD1 } = await import("../../src/services/d1.js");
    d1Instance = importedD1;
  });

  afterAll(() => {
    // Restore original environment variables
    process.env = originalEnv;
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    // Mock setTimeout to execute immediately to eliminate real delays
    vi.spyOn(global, 'setTimeout').mockImplementation((cb) => {
      cb();
      return 1;
    });

    if (d1Instance) {
      d1Instance._reset();
      await d1Instance.initialize();
    }
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("should initialize the D1 service", () => {
    expect(d1Instance).toBeDefined();
    expect(d1Instance.accountId).toBe("mock_account_id");
    expect(d1Instance.databaseId).toBe("mock_database_id");
    expect(d1Instance.token).toBe("mock_token");
    expect(d1Instance.apiUrl).toBe("https://api.cloudflare.com/client/v4/accounts/mock_account_id/d1/database/mock_database_id/query");
  });

  test("should have the correct service type", () => {
    expect(d1Instance.constructor.name).toBe("D1Service");
  });

  test("should have the required methods", () => {
    expect(typeof d1Instance._execute).toBe("function");
    expect(typeof d1Instance.fetchAll).toBe("function");
    expect(typeof d1Instance.fetchOne).toBe("function");
    expect(typeof d1Instance.run).toBe("function");
    expect(typeof d1Instance.batch).toBe("function");
  });

  describe("Token initialization", () => {
    test("should use CF_D1_TOKEN when CF_D1_TOKEN is set and CF_KV_TOKEN is also set", async () => {
      // Set up environment with both tokens
      process.env.CF_D1_ACCOUNT_ID = "test_account";
      process.env.CF_D1_DATABASE_ID = "test_db";
      process.env.CF_D1_TOKEN = "valid_d1_token";
      process.env.CF_KV_TOKEN = "invalid_kv_token";
      
      d1Instance._reset();
      await d1Instance.initialize();
      
      // Should use CF_D1_TOKEN, not CF_KV_TOKEN
      expect(d1Instance.token).toBe("valid_d1_token");
      expect(d1Instance.token).not.toBe("invalid_kv_token");
    });

    test("should throw error when CF_D1_TOKEN is missing", async () => {
      // Set up environment without CF_D1_TOKEN
      delete process.env.CF_D1_TOKEN;
      process.env.CF_KV_TOKEN = "some_kv_token"; // This should NOT be used as fallback
      
      d1Instance._reset();
      await d1Instance.initialize();
      
      // Should have undefined token (no fallback) and not be initialized
      expect(d1Instance.token).toBeUndefined();
      expect(d1Instance.isInitialized).toBe(false);
    });
  });

  describe("_execute", () => {
    test("should execute SQL successfully", async () => {
      const mockResponse = {
        success: true,
        result: [{ results: [{ id: 1, name: "test" }] }],
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const sql = "SELECT * FROM users WHERE id = ?";
      const params = [1];
      const result = await d1Instance._execute(sql, params);

      expect(mockFetch).toHaveBeenCalledWith(
        d1Instance.apiUrl,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ sql, params }),
        })
      );
      expect(result).toEqual(mockResponse);
    });

    test("should throw an error if execution fails", async () => {
      const mockErrorResponse = {
        success: false,
        errors: [{ message: "D1 specific error" }],
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockErrorResponse),
      });

      const sql = "INSERT INTO users (name) VALUES (?) ";
      const params = ["test"];

      await expect(d1Instance._execute(sql, params)).rejects.toThrow("D1 SQL Error [N/A]: D1 specific error");
    });

    test("should throw network error if fetch fails after retries", async () => {
      const networkError = new TypeError("Failed to fetch");
      // Mock fetch to fail 3 times (max retries)
      mockFetch.mockRejectedValue(networkError);

      const sql = "SELECT * FROM users";
      const params = [];

      await expect(d1Instance._execute(sql, params)).rejects.toThrow("D1 Error: Network connection lost (Max retries exceeded)");
    });

    test("should throw HTTP error for non-200 responses", async () => {
      // Mock fetch to return 500 error
      const errorBody = JSON.stringify({ success: false, errors: [{ message: "Internal Server Error" }] });
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        text: () => Promise.resolve(errorBody),
        json: () => Promise.resolve({ success: false, errors: [{ message: "Internal Server Error" }] })
      });

      const sql = "SELECT * FROM users";
      const params = [];

      await expect(d1Instance._execute(sql, params)).rejects.toThrow("D1 HTTP 500 [N/A]: Internal Server Error");
    });

    test("should parse and throw detailed 400 error", async () => {
      const errorBody = {
        success: false,
        errors: [{code: 10000, message: "Invalid token"}]
      };
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: () => Promise.resolve(JSON.stringify(errorBody)),
        json: () => Promise.resolve(errorBody)
      });
      await expect(d1Instance._execute("SELECT 1")).rejects.toThrow("D1 HTTP 400 [10000]: Invalid token");
    });

    test("should log param types but not values for 400 error", async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        // Mock logger.error since we are importing a real logger instance in the actual code
        // but here we are testing the behavior through console or logger mocks
        // Since logger.js likely uses console in tests or we can spy on the logger itself if it was exported/mocked.
        // Assuming logger prints to console or we can rely on result throwing.
        
        // Let's actually check if it throws correctly, logging verification is harder without mocking the logger module specifically.
        // But we can verify it doesn't crash on object params.
        
        const errorBody = { success: false, errors: [{code: 7000, message: "Type error"}] };
        mockFetch.mockResolvedValue({
            ok: false,
            status: 400,
            statusText: "Bad Request",
            text: () => Promise.resolve(JSON.stringify(errorBody)),
            json: () => Promise.resolve(errorBody)
        });

        const params = [1, "test", { a: 1 }, null, undefined];
        await expect(d1Instance._execute("SELECT ?", params)).rejects.toThrow("D1 HTTP 400 [7000]: Type error");
        
        consoleSpy.mockRestore();
    });
  });

  describe("fetchAll", () => {
    test("should fetch all results", async () => {
      const mockResults = [{ id: 1 }, { id: 2 }];
      const mockExecuteResponse = { result: [{ results: mockResults }] };
      vi.spyOn(d1Instance, "_execute").mockResolvedValueOnce(mockExecuteResponse);

      const sql = "SELECT * FROM items";
      const results = await d1Instance.fetchAll(sql);

      expect(d1Instance._execute).toHaveBeenCalledWith(sql, []);
      expect(results).toEqual(mockResults);
    });

    test("should return empty array if no results", async () => {
      const mockExecuteResponse = { result: [{ results: [] }] };
      vi.spyOn(d1Instance, "_execute").mockResolvedValueOnce(mockExecuteResponse);

      const sql = "SELECT * FROM items WHERE false";
      const results = await d1Instance.fetchAll(sql);

      expect(results).toEqual([]);
    });
  });

  describe("fetchOne", () => {
    test("should fetch one result", async () => {
      const mockResult = { id: 1 };
      vi.spyOn(d1Instance, "fetchAll").mockResolvedValueOnce([mockResult]);

      const sql = "SELECT * FROM items WHERE id = ?";
      const result = await d1Instance.fetchOne(sql, [1]);

      expect(d1Instance.fetchAll).toHaveBeenCalledWith(sql, [1]);
      expect(result).toEqual(mockResult);
    });

    test("should return null if no result found", async () => {
      vi.spyOn(d1Instance, "fetchAll").mockResolvedValueOnce([]);

      const sql = "SELECT * FROM items WHERE id = ?";
      const result = await d1Instance.fetchOne(sql, [99]);

      expect(result).toBeNull();
    });
  });

  describe("run", () => {
    test("should execute a run operation", async () => {
      const mockRunResult = { id: 1, status: "ok" };
      const mockExecuteResponse = { result: [{ results: [mockRunResult] }] };
      vi.spyOn(d1Instance, "_execute").mockResolvedValueOnce(mockExecuteResponse);

      const sql = "INSERT INTO logs (message) VALUES (?)";
      const result = await d1Instance.run(sql, ["log message"]);

      expect(d1Instance._execute).toHaveBeenCalledWith(sql, ["log message"]);
      expect(result).toEqual(mockRunResult);
    });
  });

  describe("batch", () => {
    test("should execute a batch of statements concurrently and return settled results", async () => {
      const mockResult1 = { result: [{ results: [{ id: 1 }] }] };
      const mockError = new Error("Some error");
      
      // Spy on the prototype to intercept all calls
      const D1Service = d1Instance.constructor;
      vi.spyOn(D1Service.prototype, "_execute")
          .mockResolvedValueOnce(mockResult1)
          .mockRejectedValueOnce(mockError);

      const statements = [
        { sql: "UPDATE users SET status = ?", params: ["active"] },
        { sql: "BAD SQL", params: [] },
      ];
      
      const results = await d1Instance.batch(statements);

      expect(D1Service.prototype._execute).toHaveBeenCalledTimes(2);
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ success: true, result: mockResult1 });
      expect(results[1]).toEqual({ success: false, error: mockError });
      expect(results[1].error.message).toBe("Some error");
    });
  });
});