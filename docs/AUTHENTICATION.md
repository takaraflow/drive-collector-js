# 鉴权配置指南

## 概述

lb-worker-js 负载均衡器提供多种鉴权机制，确保不同场景下的安全性。

## 鉴权类型

### 1. QStash 签名验证

用于处理来自 QStash 消息队列的 Webhook 请求，确保消息的真实性和完整性。

#### 配置

| 环境变量 | 说明 | 必需 | 默认值 |
|---------|------|------|---------|
| `QSTASH_CURRENT_SIGNING_KEY` | 当前有效的签名密钥 | 是 | - |
| `QSTASH_NEXT_SIGNING_KEY` | 下一个签名密钥（密钥轮换） | 否 | 使用 current |
| `SIGNATURE_EXPIRATION_WINDOW` | 签名过期时间窗口（秒） | 否 | 900 |
| `SKIP_SIGNATURE_VERIFY` | 跳过签名验证（仅测试） | 否 | false |

#### 密钥生成

```bash
# 生成 QStash v2 签名密钥
# 可以使用 openssl 或在线工具生成
openssl rand -base64 32

# 示例密钥（请使用自己的密钥）
QSTASH_CURRENT_SIGNING_KEY=your_current_signing_key_here
QSTASH_NEXT_SIGNING_KEY=your_next_signing_key_here
```

#### 签名验证流程

1. **请求头验证**:
   - `Upstash-Signature`: QStash v2 签名
   - `Upstash-Timestamp`: 请求时间戳（可选）

2. **签名算法**: HMAC-SHA256

3. **过期检查**: 默认 15 分钟内有效

4. **验证实现**:
```javascript
import { Receiver } from '@upstash/qstash';

const receiver = new Receiver({
  currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY
});

const isValid = await receiver.verify({
  signature: request.headers.get('Upstash-Signature'),
  body: requestBody,
  url: request.url,
  clockTolerance: 300 // 5分钟时钟偏差
});
```

---

### 2. 管理员 Token 认证

用于管理员 API 接口，提供对负载均衡器状态和实例信息的访问控制。

#### 配置

| 环境变量 | 说明 | 必需 | 示例 |
|---------|------|------|-------|
| `ADMIN_API_TOKEN` | 管理员 API 访问令牌 | 是 | `secure-admin-token-123` |
| `SKIP_ADMIN_AUTH` | 跳过管理员认证（仅开发） | 否 | `false` |

#### Token 生成建议

```bash
# 生成强随机 Token（推荐长度 32+ 字符）
# 方法 1: 使用 openssl
openssl rand -base64 32

# 方法 2: 使用 Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 方法 3: 使用 Python
python3 -c "import secrets; print(secrets.token_urlsafe(32))"
```

#### 安全最佳实践

1. **Token 强度**: 使用至少 32 字符的随机字符串
2. **定期轮换**: 建议每 30-90 天轮换一次
3. **环境隔离**: 不同环境使用不同的 Token
4. **访问控制**: 限制 Token 的 IP 访问范围（如需要）

---

### 3. 开发环境配置

为了方便开发和测试，提供跳过鉴权的选项。

#### 测试环境配置

```bash
# .env.development
SKIP_SIGNATURE_VERIFY=true
SKIP_ADMIN_AUTH=true
```

#### 生产环境配置

```bash
# .env.production
SKIP_SIGNATURE_VERIFY=false
SKIP_ADMIN_AUTH=false
ADMIN_API_TOKEN=your-production-token
QSTASH_CURRENT_SIGNING_KEY=your-production-signing-key
```

---

## 部署配置示例

### Cloudflare Workers

#### 使用 Wrangler CLI

```bash
# 设置开发环境
wrangler secret put ADMIN_API_TOKEN
wrangler secret put QSTASH_CURRENT_SIGNING_KEY
wrangler secret put SKIP_SIGNATURE_VERIFY
```

#### 使用 wrangler.toml

```toml
[env.development.vars]
SKIP_SIGNATURE_VERIFY = "true"
SKIP_ADMIN_AUTH = "true"

[env.production.vars]
SKIP_SIGNATURE_VERIFY = "false" 
SKIP_ADMIN_AUTH = "false"
```

### GitHub Actions

```yaml
# .github/workflows/deploy.yml
- name: Set secrets
  env:
    ADMIN_API_TOKEN: ${{ secrets.ADMIN_API_TOKEN }}
    QSTASH_CURRENT_SIGNING_KEY: ${{ secrets.QSTASH_CURRENT_SIGNING_KEY }}
  run: |
    echo "Secrets configured"
```

### Docker 环境

```dockerfile
# Dockerfile
ENV ADMIN_API_TOKEN=${ADMIN_API_TOKEN}
ENV QSTASH_CURRENT_SIGNING_KEY=${QSTASH_CURRENT_SIGNING_KEY}
ENV SKIP_SIGNATURE_VERIFY=false
ENV SKIP_ADMIN_AUTH=false
```

```bash
# docker-compose.yml
services:
  lb-worker:
    environment:
      - ADMIN_API_TOKEN=${ADMIN_API_TOKEN}
      - QSTASH_CURRENT_SIGNING_KEY=${QSTASH_CURRENT_SIGNING_KEY}
      - SKIP_SIGNATURE_VERIFY=false
      - SKIP_ADMIN_AUTH=false
```

---

## 验证和测试

### 1. QStash 签名验证测试

```javascript
// 测试签名验证
import { Receiver } from '@upstash/qstash';

async function testSignature() {
  const receiver = new Receiver({
    currentSigningKey: 'test-key',
    nextSigningKey: 'test-key'
  });
  
  // 测试有效签名
  const validSignature = await receiver.sign({
    body: '{"test": "data"}',
    url: 'https://example.com/webhook'
  });
  
  const isValid = await receiver.verify({
    signature: validSignature,
    body: '{"test": "data"}',
    url: 'https://example.com/webhook'
  });
  
  console.log('签名验证结果:', isValid);
}
```

### 2. 管理员 Token 测试

```bash
# 测试 Token 认证
ADMIN_TOKEN="test-token" API_BASE="http://localhost:8787"

# 测试有效 Token
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
     "$API_BASE/api/instances"

# 测试无效 Token
curl -H "Authorization: Bearer invalid-token" \
     "$API_BASE/api/instances"

# 测试缺少 Token
curl "$API_BASE/api/instances"
```

### 3. 环境变量验证

```bash
# 创建验证脚本
cat > check-auth-config.sh << 'EOF'
#!/bin/bash

echo "=== 鉴权配置检查 ==="

# 检查 QStash 配置
if [ -n "$QSTASH_CURRENT_SIGNING_KEY" ]; then
    echo "✅ QStash 签名密钥已配置"
else
    echo "❌ QSTASH_CURRENT_SIGNING_KEY 未配置"
fi

# 检查管理员 Token
if [ -n "$ADMIN_API_TOKEN" ]; then
    echo "✅ 管理员 Token 已配置"
else
    echo "❌ ADMIN_API_TOKEN 未配置"
fi

# 检查开发环境配置
if [ "$SKIP_SIGNATURE_VERIFY" = "true" ]; then
    echo "⚠️  签名验证已跳过（开发模式）"
fi

if [ "$SKIP_ADMIN_AUTH" = "true" ]; then
    echo "⚠️  管理员认证已跳过（开发模式）"
fi

echo "==================="
EOF

chmod +x check-auth-config.sh
./check-auth-config.sh
```

---

## 故障排除

### 常见问题

#### 1. QStash 签名验证失败

**错误**: `Signature verification failed`

**排查步骤**:
1. 检查 `QSTASH_CURRENT_SIGNING_KEY` 是否正确
2. 确认签名密钥格式（Base64 编码）
3. 验证时间戳是否在有效窗口内
4. 检查请求 URL 是否与签名时一致

#### 2. 管理员 Token 无效

**错误**: `401 Unauthorized`

**排查步骤**:
1. 检查 `ADMIN_API_TOKEN` 环境变量
2. 确认请求头格式：`Authorization: Bearer <token>`
3. 验证 Token 是否包含特殊字符需要 URL 编码

#### 3. 开发环境配置问题

**现象**: 本地测试时鉴权失败

**解决方案**:
```bash
# 检查当前环境
echo $NODE_ENV
echo $SKIP_SIGNATURE_VERIFY
echo $SKIP_ADMIN_AUTH

# 临时跳过鉴权（仅开发）
export SKIP_SIGNATURE_VERIFY=true
export SKIP_ADMIN_AUTH=true
```

### 调试工具

#### 启用详细日志

```bash
# 设置环境变量
export DEBUG_LOGS=true

# 或者直接在代码中设置
process.env.DEBUG_LOGS = 'true';
```

#### 鉴权测试工具

```javascript
// auth-test.js
import crypto from 'crypto';

function generateTestToken() {
  return crypto.randomBytes(32).toString('hex');
}

function testAdminAuth() {
  const token = generateTestToken();
  console.log('测试 Token:', token);
  
  // 测试请求
  const response = await fetch('/api/instances', {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });
  
  console.log('响应状态:', response.status);
  console.log('响应内容:', await response.json());
}
```

---

## 安全检查清单

### 部署前检查

- [ ] 所有密钥都通过环境变量或安全的 secret 管理系统配置
- [ ] 生产环境禁用 `SKIP_*` 环境变量
- [ ] QStash 签名密钥使用强随机值
- [ ] 管理 Token 使用足够长度的随机字符串
- [ ] 配置了适当的签名过期时间
- [ ] 实施了密钥轮换策略

### 运行时监控

- [ ] 监控认证失败率
- [ ] 告警异常的认证模式
- [ ] 定期检查密钥有效性
- [ ] 监控 API 访问日志

---

## 相关文档

- [管理员 API 文档](./ADMIN_API.md)
- [API 契约文档](./CONTRACT.md)
- [项目 README](../README.md)
- [Cloudflare Workers 文档](https://developers.cloudflare.com/workers/)
- [QStash 文档](https://upstash.com/docs/qstash)

---

**最后更新**: 2026-01-09  
**维护者**: shangxin <shangxin@outlook.com>