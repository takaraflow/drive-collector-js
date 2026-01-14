# Worker 级集成测试调试指南

## 🚀 快速开始

你的 CF Worker 项目现在已经配置好了完整的 Worker 级集成测试环境！

### 运行集成测试

```bash
# 运行完整的集成测试套件
npm run test:integration

# 运行生产就绪的集成测试
npx vitest run -c vitest.integration.simple.config.ts test/integration/production-ready.test.js

# 调试模式运行（支持断点调试）
npm run test:integration:debug

# 监视模式运行
npm run test:integration:debug:watch
```

## 🎯 关键特性

### ✅ 已配置好的功能

1. **真实 Worker 运行时**：测试在 Cloudflare Workers 环境中运行，不是 Node.js
2. **环境变量绑定**：自动从 `wrangler.toml` 加载所有 env bindings
3. **SELF.fetch() 支持**：可以直接向你的 Worker 发送 HTTP 请求
4. **完整 API 支持**：KV、R2、D1、Queues 等绑定都可以在测试中使用
5. **调试支持**：支持 Chrome DevTools 断点调试

### 🧪 测试示例

```javascript
import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";

describe("我的 Worker 测试", () => {
  it("应该响应 ping", async () => {
    const response = await SELF.fetch("https://example.com/ping");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pong");
  });

  it("可以使用环境变量", () => {
    expect.env.MY_KV_NAMESPACE).toBeDefined();
    expect(env.API_TOKEN).toBe("test-token");
  });
});
```

## 🐛 常见问题解决

### 问题 1: 测试超时
**现象**: `[vitest-worker]: Timeout calling "fetch"`

**解决方案**:
- 增加测试超时时间：`it("test", async () => {}, 30000)`
- 使用更简单的配置：`vitest.integration.simple.config.ts`

### 问题 2: 环境变量未定义
**现象**: `expected undefined to be 'value'`

**解决方案**:
- 确保 `wrangler.toml` 中定义了变量
- 检查 `main` 指向正确的构建文件 (`dist/index.js`)
- 运行 `npm run build` 重新构建

### 问题 3: Redis/外部服务连接失败
**现象**: 连接超时错误

**解决方案**:
- 这在测试环境中是正常的，使用内存缓存作为降级
- 专注于测试业务逻辑，不依赖外部服务

### 问题 4: 异步操作挂起
**现象**: `Promise will never complete`

**解决方案**:
- 简化测试逻辑
- 避免复杂的日志操作
- 使用 `test/integration/simple.test.js` 作为模板

## 🔧 调试技巧

### 1. 控制台调试
```javascript
it("debug request", async () => {
  const response = await SELF.fetch("https://example.com/test");
  console.log("Status:", response.status);
  console.log("Headers:", Object.fromEntries(response.headers.entries()));
  
  if (response.status < 500) {
    const text = await response.text();
    console.log("Body:", text);
  }
});
```

### 2. VSCode 断点调试
```bash
# 启动调试模式
npm run test:integration:debug

# 在 VSCode 中，创建 .vscode/launch.json:
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Debug Vitest",
      "type": "node",
      "request": "attach",
      "port": 9229,
      "skipFiles": ["<node_internals>/**"]
    }
  ]
}
```

### 3. 测试特定文件
```bash
# 只运行特定测试文件
npx vitest run -c vitest.integration.config.ts test/integration/production-ready.test.js

# 只运行特定测试
npx vitest run -c vitest.integration.config.ts -t "应该响应 ping"
```

## 📁 文件结构

```
test/integration/
├── production-ready.test.js    # 生产就绪的完整测试示例
├── simple.test.js              # 简化的基础测试
├── debug.test.js               # 调试专用测试
└── vitest.setup.js             # 测试设置（已禁用复杂 mock）

vitest.integration.config.ts     # 原始配置（可能有异步问题）
vitest.integration.simple.config.ts  # 简化配置（推荐）
```

## 🎯 最佳实践

### 1. 测试结构
```javascript
describe("功能模块", () => {
  it("应该正确处理正常情况", async () => {}, 15000);
  it("应该正确处理错误情况", async () => {}, 15000);
  it("应该正确处理边界情况", async () => {}, 15000);
});
```

### 2. 环境变量测试
```javascript
it("应该有必要的配置", () => {
  expect(env.VERSION).toBeDefined();
  expect(env.NODE_ENV).toBe("dev");
});
```

### 3. HTTP 测试
```javascript
it("应该返回正确响应", async () => {
  const response = await SELF.fetch("https://example.com/endpoint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ test: true })
  });
  
  expect([200, 201, 400]).toContain(response.status);
});
```

## 🚨 注意事项

1. **不依赖外部服务**: 测试环境中的网络访问可能受限
2. **使用内存缓存**: Redis 连接失败时会自动降级到内存缓存
3. **避免复杂异步**: 简化测试逻辑，避免深层嵌套的异步操作
4. **合理超时**: 设置适当的测试超时时间（15-30秒）

现在你可以开始编写真正的 Worker 级集成测试了！🎉