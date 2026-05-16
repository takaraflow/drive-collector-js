import { vi, describe, it, expect, beforeEach } from "vitest";

const mockCache = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
};

const mockD1 = {
    fetchOne: vi.fn(),
    run: vi.fn(),
};

vi.mock("../../src/services/CacheService.js", () => ({
    cache: mockCache,
}));

vi.mock("../../src/services/d1.js", () => ({
    d1: mockD1,
}));

vi.mock("../../src/services/logger/index.js", () => ({
    logger: {
        withModule: () => ({
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
        }),
    }
}));

const { ApiKeyRepository } = await import("../../src/repositories/ApiKeyRepository.js");

describe("ApiKeyRepository", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("getOrCreateToken", () => {
        it("应该优先从缓存获取令牌", async () => {
            mockCache.get.mockResolvedValue("cached_token");

            const token = await ApiKeyRepository.getOrCreateToken("user123");

            expect(token).toBe("cached_token");
            expect(mockCache.get).toHaveBeenCalledWith("api_key:user123");
            expect(mockD1.fetchOne).not.toHaveBeenCalled();
        });

        it("缓存缺失时应查询 D1 并回填缓存", async () => {
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchOne.mockResolvedValue({ token: "db_token" });

            const token = await ApiKeyRepository.getOrCreateToken("user123");

            expect(token).toBe("db_token");
            expect(mockCache.set).toHaveBeenCalledWith("api_key:user123", "db_token", expect.any(Number));
        });

        it("新用户应生成令牌并存入 D1 和缓存", async () => {
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchOne
                .mockResolvedValueOnce(null)
                .mockImplementationOnce(async () => ({ token: mockD1.run.mock.calls[0][1][1] }));

            const token = await ApiKeyRepository.getOrCreateToken("user456");

            expect(token).toContain("dc_user_user456_");
            expect(mockD1.run).toHaveBeenCalledWith(
                expect.stringContaining("INSERT OR IGNORE INTO api_keys"),
                ["user456", token, expect.any(Number), expect.any(Number)]
            );
        });

        it("并发创建冲突时应在 INSERT OR IGNORE 后读取已存在令牌", async () => {
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchOne
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce({ token: "winner_token" });
            mockD1.run.mockResolvedValue({ changes: 0 });

            const token = await ApiKeyRepository.getOrCreateToken("user456");

            expect(token).toBe("winner_token");
            expect(mockD1.run).toHaveBeenCalledWith(
                expect.stringContaining("INSERT OR IGNORE INTO api_keys"),
                expect.arrayContaining(["user456"])
            );
            expect(mockD1.fetchOne).toHaveBeenCalledTimes(2);
            expect(mockCache.set).toHaveBeenCalledWith("api_key:user456", "winner_token", expect.any(Number));
        });
    });

    describe("findUserIdByToken", () => {
        it("应该根据令牌反查 userId 并维护缓存", async () => {
            mockCache.get.mockResolvedValue(null);
            mockD1.fetchOne.mockResolvedValue({ user_id: "user789" });

            const userId = await ApiKeyRepository.findUserIdByToken("some_token");

            expect(userId).toBe("user789");
            expect(mockCache.set).toHaveBeenCalledWith("token_to_user:some_token", "user789", 3600);
        });
    });
});
