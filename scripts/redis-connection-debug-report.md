# Redis 连接问题诊断报告

## 🔴 问题描述

**错误信息**: `Error: connect ECONNREFUSED 127.0.0.1:6379`

**用户报告**: 手动连接命令使用远程 URL 成功，但 CacheService 失败

## 📊 根本原因分析

### 1. 配置解析逻辑问题

CacheService 的配置解析顺序：

```javascript
// 第一步：标准环境变量
const redisUrl = process.env.REDIS_URL || config.redis.url;
const redisHost = process.env.REDIS_HOST || config.redis.host;
const redisPort = parseInt(process.env.REDIS_PORT, 10) || config.redis.port || 6379;
const redisPassword = process.env.REDIS_PASSWORD || config.redis.password;

// 第二步：Northflank 环境变量 (如果标准变量未配置)
if (!redisUrl && !redisHost) {
    this.redisUrl = process.env.NF_REDIS_URL;
    this.redisHost = process.env.NF_REDIS_HOST;
    this.redisPort = parseInt(process.env.NF_REDIS_PORT, 10) || this.redisPort;
    this.redisPassword = process.env.NF_REDIS_PASSWORD || this.redisPassword;
}
```

### 2. ECONNREFUSED 错误的常见原因

| 原因 | 影响 | 严重程度 |
|------|------|----------|
| 使用 `127.0.0.1` 或 `localhost` | 在远程容器中指向自身，无法访问外部 Redis | 🔴 严重 |
| 缺少 Redis 密码 | 远程 Redis 需要认证 | 🟡 中等 |
| 使用 `redis://` 而非 `rediss://` | 远程环境通常需要 TLS | 🟡 中等 |
| SNI 配置错误 | TLS 握手失败 | 🟡 中等 |

### 3. ioredis 配置分析

**当前配置** (可能导致 ECONNREFUSED):
```javascript
{
  host: "127.0.0.1",  // ❌ 错误：使用 localhost
  port: 6379,
  password: undefined, // ❌ 错误：缺少密码
  tls: {
    rejectUnauthorized: false,
    servername: "127.0.0.1"  // ❌ 错误：SNI 使用 localhost
  }
}
```

**正确配置**:
```javascript
{
  url: "rediss://user:password@master.drive-collector-redis--xxxx.addon.code.run:6379",
  // 或者
  host: "master.drive-collector-redis--xxxx.addon.code.run",
  port: 6379,
  password: "your_password",
  tls: {
    rejectUnauthorized: false,
    servername: "master.drive-collector-redis--xxxx.addon.code.run"  // ✅ 正确：远程主机名
  }
}
```

## 🔍 CacheService 详细错误日志

### 错误事件监听器

CacheService 配置了完整的错误事件监听：

1. **connect**: 记录连接成功信息
2. **ready**: 记录连接建立时间
3. **reconnecting**: 记录重连状态
4. **error**: 记录详细错误信息
5. **close**: 记录连接关闭
6. **wait**: 调试命令排队
7. **end**: 警告连接结束
8. **select**: 调试数据库选择

### 错误日志字段

当发生 ECONNREFUSED 错误时，CacheService 会记录：

```javascript
logger.error(`🚨 Redis ERROR: ${error.message}`, {
    code: error.code,           // "ECONNREFUSED"
    errno: error.errno,         // -111
    syscall: error.syscall,     // "connect"
    hostname: error.hostname,   // undefined
    port: error.port,           // 6379
    address: error.address,     // "127.0.0.1"
    uptime: "0s",               // 连接失败
    node_env: process.env.NODE_ENV,
    platform: process.platform,
    stack: error.stack?.split('\n')[0]  // 堆栈第一行
});
```

### 完整错误示例

```
🚨 Redis ERROR: connect ECONNREFUSED 127.0.0.1:6379
{
  "code": "ECONNREFUSED",
  "errno": -111,
  "syscall": "connect",
  "address": "127.0.0.1",
  "port": 6379,
  "uptime": "0s",
  "node_env": "production",
  "platform": "linux",
  "stack": "Error: connect ECONNREFUSED 127.0.0.1:6379\n    at TCPConnectWrap.afterConnect..."
}
```

## ✅ 解决方案

### 方案 1：使用 REDIS_URL (推荐)

```bash
# 在 Northflank 仪表板或 .env 文件中设置：
REDIS_URL=rediss://username:password@master.drive-collector-redis--qmnl9h54d875.addon.code.run:6379
```

### 方案 2：使用单独参数

```bash
REDIS_HOST=master.drive-collector-redis--qmnl9h54d875.addon.code.run
REDIS_PORT=6379
REDIS_PASSWORD=your_password
REDIS_SNI_SERVERNAME=master.drive-collector-redis--qmnl9h54d875.addon.code.run
```

### 方案 3：Northflank 格式

```bash
NF_REDIS_URL=rediss://username:password@master.drive-collector-redis--qmnl9h54d875.addon.code.run:6379
```

## 🎯 配置检查清单

- [ ] 使用远程主机名而非 `localhost` 或 `127.0.0.1`
- [ ] 配置 Redis 密码
- [ ] 使用 `rediss://` 协议 (TLS)
- [ ] 设置正确的 SNI 主机名
- [ ] 禁用证书验证 (`rejectUnauthorized: false`)
- [ ] 确认环境变量已正确传递到容器

## 📝 调试步骤

1. **检查当前配置**:
   ```bash
   node scripts/debug-redis.js
   ```

2. **分析 CacheService 配置**:
   ```bash
   node scripts/analyze-cache-service.js
   ```

3. **模拟 ECONNREFUSED 场景**:
   ```bash
   node scripts/simulate-econnrefused.js
   ```

4. **查看详细错误信息**:
   ```bash
   node scripts/enhanced-error-diagnostic.js
   ```

## 🔧 故障转移机制

CacheService 包含自动故障转移功能：

- **触发条件**: 连续 2 次失败
- **备用提供商**: Cloudflare KV → Upstash Redis
- **恢复检查**: 每 30 分钟尝试恢复主提供商
- **心跳机制**: 每 30 秒 PING 检测连接健康

## 📋 总结

**问题根源**: 配置中使用 `127.0.0.1:6379` 而非远程 Redis URL

**解决方案**: 设置正确的 `REDIS_URL` 环境变量，使用 `rediss://` 协议和远程主机名

**错误日志**: CacheService 已配置详细错误记录，包含完整的堆栈跟踪和诊断信息

**验证方法**: 使用提供的诊断脚本检查配置并模拟连接场景