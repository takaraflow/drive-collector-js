import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";

describe("Worker 集成测试 - 核心功能验证", () => {
  
  it("确认环境已通过 .dev.vars 物理隔离", () => {
    // 如果 .dev.vars 生效，这里应该是 []
    expect(env.CACHE_PROVIDERS).toBe("[]");
    expect(env.NODE_ENV).toBe("test");
    console.log("✅ 物理隔离确认成功");
  });

  it("各端点应快速响应 (验证无外部连接延迟)", async () => {
    const testCases = [
      { name: "健康检查", path: "/health", status: 200 },
      { name: "认证拦截", path: "/api/instances", status: 401 },
      { name: "CORS 预检", path: "/", method: "OPTIONS", status: 204 }
    ];

    for (const tc of testCases) {
      const startTime = Date.now();
      const response = await SELF.fetch(`http://localhost${tc.path}`, {
        method: tc.method || "GET"
      });
      
      await response.text(); // 消费 body
      const duration = Date.now() - startTime;

      expect(response.status, `${tc.name} 状态码错误`).toBe(tc.status);
      
      // 物理隔离后，响应必须在 2000ms 内
      expect(duration, `${tc.name} 响应太慢 (${duration}ms)，说明仍有外部连接`).toBeLessThan(2000);
      console.log(`✅ ${tc.name} 通过 (${duration}ms)`);
    }
  }, 30000);
});

describe("Worker 配置完整性", () => {
  it("基础变量应存在于 env 对象", () => {
    expect(env.VERSION).toBeDefined();
    expect(env.ADMIN_API_TOKEN).toBe("test-token");
  });
});