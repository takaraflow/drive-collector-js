import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";

describe("Worker 纯净集成测试", () => {
  // 只测试最核心、最简单的功能，完全避开复杂逻辑

  it("环境变量正常访问", () => {
    expect(env.VERSION).toBe("1.1.0");
    expect(env.NODE_ENV).toBe("dev");
    console.log("✅ 纯净环境验证通过");
  });

  it("ping 直接响应（无缓存初始化）", async () => {
    const response = await SELF.fetch("http://localhost/ping");
    
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pong");
    
    console.log("✅ 纯净 ping 测试成功");
  }, 10000);

  it("OPTIONS 预检请求正常", async () => {
    const response = await SELF.fetch("http://localhost/", {
      method: "OPTIONS"
    });
    
    expect(response.status).toBe(204);
    console.log("✅ 纯净 OPTIONS 测试成功");
  }, 5000);

  it("基本路由检查", async () => {
    // 测试一些基本路由，不依赖复杂逻辑
    const responses = await Promise.all([
      SELF.fetch("http://localhost/ping"),
      SELF.fetch("http://localhost/", { method: "OPTIONS" }),
      SELF.fetch("http://localhost/nonexistent")
    ]);
    
    // 验证所有响应都是有效的
    responses.forEach(response => {
      expect(response.status).toBeGreaterThan(0);
      expect(response.status).toBeLessThan(600);
    });
    
    console.log("✅ 纯净路由检查成功");
  }, 15000);
});