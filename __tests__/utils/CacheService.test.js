import { describe, it, expect, beforeEach, vi } from "vitest";
import { cacheService } from "../../src/utils/CacheService.js";

describe("CacheService", () => {
    beforeEach(() => {
        cacheService.clear();
        vi.useFakeTimers();
    });

    it("should set and get cache", () => {
        cacheService.set("test", { foo: "bar" });
        expect(cacheService.get("test")).toEqual({ foo: "bar" });
    });

    it("should return null for expired cache", () => {
        cacheService.set("test", "value", 1000);
        vi.advanceTimersByTime(1001);
        expect(cacheService.get("test")).toBeNull();
    });

    it("should del cache", () => {
        cacheService.set("test", "value");
        cacheService.del("test");
        expect(cacheService.get("test")).toBeNull();
    });

    it("should use getOrSet correctly", async () => {
        const loader = vi.fn().mockResolvedValue("loaded");
        const result1 = await cacheService.getOrSet("key", loader, 1000);
        expect(result1).toBe("loaded");
        expect(loader).toHaveBeenCalledTimes(1);

        const result2 = await cacheService.getOrSet("key", loader, 1000);
        expect(result2).toBe("loaded");
        expect(loader).toHaveBeenCalledTimes(1); // Should use cache
    });
});