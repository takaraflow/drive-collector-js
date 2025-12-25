# Upstash KV 迁移指南

## 概述

本项目现在支持使用 Upstash Redis 作为 KV 存储的后端替代方案，可以无缝替换 Cloudflare KV。

更重要的是，系统引入了**智能故障转移 (Smart Failover)** 机制，可以在 Cloudflare KV 出现额度超限或网络故障时，自动无缝切换到 Upstash，确保高可用性。

## 迁移步骤

### 1. 注册 Upstash 账户
- 访问 [upstash.com](https://upstash.com)
- 创建免费账户
- 创建一个 Redis 数据库

### 2. 获取连接信息
在 Upstash 控制台中：
- 找到你的 Redis 数据库
- 复制 **REST API** 部分的连接信息：
  - `UPSTASH_REDIS_REST_URL`
  - `UPSTASH_REDIS_REST_TOKEN`

### 3. 配置环境变量
在你的部署平台（Zeabur、Railway 等）中设置以下环境变量：

```bash
# [可选] 强制使用 Upstash (如果不设置，默认使用 Cloudflare KV，但在故障时自动切换)
# KV_PROVIDER=upstash

# Upstash 连接信息 (配置后自动开启故障转移功能)
UPSTASH_REDIS_REST_URL=https://your-endpoint.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token-here

# Cloudflare KV 变量 (保持原样，作为首选存储)
CF_ACCOUNT_ID=...
CF_KV_NAMESPACE_ID=...
CF_KV_TOKEN=...
```

### 4. 部署应用
重新部署应用。

## 智能故障转移机制

系统默认优先使用 **Cloudflare KV**（速度快，有免费额度）。

当发生以下情况时，系统会自动触发故障转移：
1.  **额度超限**：Cloudflare 返回 `free usage limit exceeded` 或 `quota exceeded`。
2.  **网络故障**：连接 Cloudflare API 超时或失败。
3.  **API 限制**：触发 `rate limit`。

**触发条件**：连续失败 **3次**。

**故障转移行为**：
- 自动切换到 Upstash Redis。
- 实例进入“故障转移模式”。
- **任务恢复策略**：为防止与主集群冲突，故障转移实例在启动时会**延迟 30 秒**恢复积压任务。
- **自动恢复**：后台每 **30分钟** 检查一次 Cloudflare KV 是否恢复，如果恢复则自动切回。

## 功能对比

| 功能 | Cloudflare KV | Upstash Redis |
|------|---------------|---------------|
| 存储类型 | Key-Value | Redis |
| API 类型 | REST | REST (兼容 Redis) |
| 过期时间 | 支持 | 支持 |
| 批量操作 | 原生支持 | 通过循环实现 |
| 持久性 | 高 | 高 |
| 延迟 | 视区域而定 | 视区域而定 |
| 免费额度 | 有限 | 10,000 次请求/月 |

## 测试集成

运行验证脚本来测试 Upstash 连接：

```bash
# 编辑 scripts/validate-upstash.js 中的连接信息
node scripts/validate-upstash.js
```

## 故障排除

### 常见错误

1. **"Upstash配置不完整"**
   - 检查 `UPSTASH_REDIS_REST_URL` 和 `UPSTASH_REDIS_REST_TOKEN` 是否正确设置

2. **连接超时**
   - 检查网络连接
   - 确认 Upstash 服务状态

3. **认证失败**
   - 验证 token 是否正确
   - 检查 token 是否过期

### 性能注意事项

- Upstash 的批量操作通过循环实现，可能比 Cloudflare KV 稍慢
- 对于高频操作，建议评估性能影响

## 支持

如果遇到问题，请检查：
1. 环境变量配置
2. Upstash 控制台的状态
3. 网络连接
4. 应用日志