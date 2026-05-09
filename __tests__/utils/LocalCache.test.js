import { describe, test, expect, beforeEach, vi } from 'vitest';
import { localCache } from "../../src/utils/LocalCache.js";

describe("LocalCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localCache.clear();
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

  describe("isUnchanged", () => {
    it("should return false if cache is missing", () => {
      expect(localCache.isUnchanged("missing", "value")).toBe(false);
    });

    it("should return false if cache is expired", () => {
      localCache.set("test", "value", 1000);
      vi.advanceTimersByTime(1001);
      expect(localCache.isUnchanged("test", "value")).toBe(false);
    });

    it("should correctly compare primitive values", () => {
      localCache.set("testStr", "value");
      expect(localCache.isUnchanged("testStr", "value")).toBe(true);
      expect(localCache.isUnchanged("testStr", "different")).toBe(false);

      localCache.set("testNum", 42);
      expect(localCache.isUnchanged("testNum", 42)).toBe(true);
      expect(localCache.isUnchanged("testNum", 43)).toBe(false);
    });

    it("should correctly compare object values", () => {
      localCache.set("testObj", { a: 1, b: 2 });
      expect(localCache.isUnchanged("testObj", { a: 1, b: 2 })).toBe(true);
      expect(localCache.isUnchanged("testObj", { a: 1, b: 3 })).toBe(false);
    });

    it("should fallback to exact match for non-serializable values", () => {
      const cyclicObj = {};
      cyclicObj.self = cyclicObj;
      localCache.set("testCyclic", cyclicObj);

      // Exactly the same reference
      expect(localCache.isUnchanged("testCyclic", cyclicObj)).toBe(true);

      // Different reference
      const anotherCyclicObj = {};
      anotherCyclicObj.self = anotherCyclicObj;
      expect(localCache.isUnchanged("testCyclic", anotherCyclicObj)).toBe(false);
    });
  });
});
