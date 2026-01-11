import { localCache } from "../../src/utils/LocalCache.js";

describe("LocalCache", () => {
    beforeEach(() => {
        localCache.clear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("should set and get cache", () => {
        localCache.set("test", { foo: "bar" });
        expect(localCache.get("test")).toEqual({ foo: "bar" });
    });

    it("should return null for expired cache", () => {
        localCache.set("test", "value", 1000);
        vi.advanceTimersByTime(1001);
        expect(localCache.get("test")).toBeNull();
    });

    it("should del cache", () => {
        localCache.set("test", "value");
        localCache.del("test");
        expect(localCache.get("test")).toBeNull();
    });

    it("should use getOrSet correctly", async () => {
        const loader = vi.fn().mockResolvedValue("loaded");
        const result1 = await localCache.getOrSet("key", loader, 1000);
        expect(result1).toBe("loaded");
        expect(loader).toHaveBeenCalledTimes(1);

        const result2 = await localCache.getOrSet("key", loader, 1000);
        expect(result2).toBe("loaded");
        expect(loader).toHaveBeenCalledTimes(1); // Should use cache
    });
});