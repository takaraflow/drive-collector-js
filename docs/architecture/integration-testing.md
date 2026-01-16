# 快速开始：Worker 集成测试

## 🚀 5分钟快速上手

### 1. 运行现有的集成测试
```bash
# 验证核心路由、绑定和环境
npm run test:integration
```

### 2. 编写你的测试文件
创建 `test/integration/my-feature.test.js`：

```javascript
import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";

describe("功能验证", () => {
  it("健康检查端点工作正常", async () => {
    // 1. 发起请求
    const response = await SELF.fetch("http://localhost/health");
    
    // 2. 验证状态码
    expect(response.status).toBe(200);
    
    // 3. 立即消费响应体 (重要！)
    const data = await response.json();
    expect(data.status).toBeDefined();
  });

  it("环境变量已正确加载", () => {
    expect(env.NODE_ENV).toBe("test");
    expect(env.VERSION).toBeDefined();
  });
});
```

### 3. 环境隔离说明
测试运行期间，根目录下的 **`.dev.vars`** 会强制将 Worker 切换到“离线模式”：
- ❌ 不连接生产 Redis
- ❌ 不发送 Axiom 日志
- ✅ 仅使用内存缓存和本地模拟绑定

## 🔧 常用命令

| 命令 | 用途 |
| :--- | :--- |
| `npm run test:integration` | 运行所有集成测试。 |
| `npm run test:debug` | 开启断点调试模式。 |
| `npm run test:watch` | 监视文件变化并实时测试。 |
| `npm test` | 一键运行单元测试 + 集成测试。 |

## ⚠️ 避坑指南
- **Body 消费**：每次 `SELF.fetch` 后必须调用 `response.text()` 或 `json()`，否则测试可能会卡死。
- **并发控制**：避免在循环中使用 `Promise.all`，推荐使用 `for` 循环顺序执行。
- **环境污染**：如果发现测试变慢（>2s），请检查 `.dev.vars` 是否包含 `CACHE_PROVIDERS=[]`。

详细指南请查看: [WORKER_INTEGRATION_TESTING.md](./WORKER_INTEGRATION_TESTING.md)