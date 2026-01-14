# Cloudflare Workers 集成测试指南

## 📖 概述

本文档介绍如何使用 `@cloudflare/vitest-pool-workers` 在本地环境中进行 Cloudflare Workers 的集成测试。这套系统让你能够在真实的 Workers 运行时（workerd）中测试代码，而不是在 Node.js 环境中模拟。

## 🚀 快速开始

### 运行测试

```bash
# 运行集成测试套件 (自动备份 .env 以实现隔离)
npm run test:integration

# 运行监视模式 (Watch Mode)
npm run test:watch

# 调试模式运行 (支持断点)
npm run test:debug
```

### 编写第一个测试

```javascript
// test/integration/my-first.test.js
import { describe, it, expect } from "vitest";
import { SELF, env } from "cloudflare:test";

describe("我的 Worker 功能", () => {
  it("应该响应健康检查端点", async () => {
    // 使用 SELF.fetch 发送请求到当前 Worker
    const response = await SELF.fetch("http://localhost/health");
    expect(response.status).toBe(200);
    
    const data = await response.json();
    expect(data).toHaveProperty('status');
  });

  it("应该能访问环境变量", () => {
    expect(env.VERSION).toBeDefined();
    expect(env.NODE_ENV).toBe("test"); // 集成测试环境默认为 test
  });
});
```

## 🔧 环境隔离与配置

为了确保集成测试的稳定性和速度，我们采用了**物理隔离策略**。

### 1. 变量覆盖 (.dev.vars)
在根目录下存在一个 `.dev.vars` 文件（集成测试专用）。由于 Cloudflare 的加载规则，该文件的优先级高于 `.env`，从而确保测试环境永远不会连接到生产环境的 Redis 或 Axiom 服务。

**测试环境配置重点：**
- `CACHE_PROVIDERS=[]`: 强制使用内存缓存，避免网络延迟和死锁。
- `NODE_ENV=test`: 标记为测试环境。
- `ENABLE_OTEL=false`: 禁用追踪系统以防止异步挂起。

### 2. 测试专属配置 (wrangler.test.toml)
我们使用 `wrangler.test.toml` 定义测试环境的基础绑定（Bindings）。Vitest 配置会自动引用此文件。

### 3. Vitest 配置 (vitest.integration.config.ts)
```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    name: "integration",
    globals: true,
    testTimeout: 30000,
    fileParallelism: false, // 串行执行以确保本地 runtime 稳定性
    poolOptions: {
      workers: {
        singleWorker: true,
        main: "./src/index.js", // 显式指定入口
        wrangler: {
          configPath: "./wrangler.test.toml",
        }
      },
    },
    include: ["test/integration/core-integration.test.js"],
  },
});
```

## 🎯 核心概念

### SELF 对象
`SELF` 代表你的 Worker 实例。调用 `SELF.fetch()` 会直接进入你的 `export default { fetch() {...} }` 入口。

**注意**：在发送请求后，**务必立即消费响应体**（如 `await response.json()` 或 `await response.text()`），否则本地 Runtime 可能会因为资源未释放而判定请求挂起。

### ENV 对象
`env` 对象包含了 `wrangler.test.toml` 和 `.dev.vars` 中定义的所有绑定。在测试中，你可以直接通过 `env.MY_KV` 等方式访问它们。

## 🧪 最佳实践

### 1. 避免入侵生产代码
不要为了测试而在 `src/` 下添加特殊的路由（如 `/ping`）。应利用现有的生产接口（如 `/health`）进行验证。

### 2. 顺序执行验证
由于本地 `workerd` 环境的限制，在测试中推荐使用顺序执行而不是高并发的 `Promise.all`：

```javascript
it("稳定性验证", async () => {
  for (let i = 0; i < 3; i++) {
    const response = await SELF.fetch(`http://localhost/health?seq=${i}`);
    expect(response.status).toBe(200);
    await response.json(); // 立即消费以释放资源
  }
});
```

### 3. 响应时间断言
在隔离了外部依赖后，本地集成测试的响应时间应非常快（通常 < 100ms）。如果响应时间超过 2000ms，通常意味着环境隔离失效，Worker 正在尝试连接外部服务。

## 🐛 调试技巧

1. **断点调试**：运行 `npm run test:debug`，然后在 VSCode 中使用 `Attach to Node Process` 挂载到 9229 端口。
2. **查看日志**：测试运行时，Worker 内部的 `console.log` 会直接输出到终端。
3. **环境确认**：在测试开始前运行 `expect(env.CACHE_PROVIDERS).toBe("[]")` 确认隔离是否生效。

## 🎯 总结

通过这套集成测试方案，你可以在不部署的情况下，验证 Worker 的完整生命周期、路由解析和绑定逻辑。这与 `npm run test:unit`（纯逻辑单元测试）互为补充，构建了完整的质量保障体系。🚀