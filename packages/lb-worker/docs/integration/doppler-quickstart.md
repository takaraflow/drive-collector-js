# Doppler 快速开始指南

## 🚀 5分钟快速集成Doppler

### 步骤 1: 安装Doppler CLI

```bash
npm install -g @dopplerhq/cli
```

### 步骤 2: 创建Doppler项目和secrets

```bash
# 登录Doppler
doppler login

# 创建项目
doppler projects create lb-worker

# 创建环境
doppler configs create dev
doppler configs create prod

# 添加secrets (开发环境)
doppler secrets set QSTASH_CURRENT_SIGNING_KEY --config=dev
doppler secrets set UPSTASH_REDIS_REST_URL --config=dev
doppler secrets set UPSTASH_REDIS_REST_TOKEN --config=dev
doppler secrets set AXIOM_TOKEN --config=dev

# 添加secrets (生产环境)
doppler secrets set QSTASH_CURRENT_SIGNING_KEY --config=prod
doppler secrets set UPSTASH_REDIS_REST_URL --config=prod
doppler secrets set UPSTASH_REDIS_REST_TOKEN --config=prod
doppler secrets set AXIOM_TOKEN --config=prod
doppler secrets set AXIOM_DATASET --config=prod
doppler secrets set AXIOM_ORG_ID --config=prod
```

### 步骤 3: 配置项目环境变量

创建 `.env.doppler` 文件：

```bash
# Doppler配置
SECRETS_PROVIDER=doppler
DOPPLER_PROJECT=lb-worker
DOPPLER_TOKEN=dp.st.dev.xxxxxx  # 从Doppler CLI获取

# 环境配置
NODE_ENV=dev

# 基础设施配置 (保持现有)
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
WORKER_NAME=lb-worker-js-dev
```

### 步骤 4: 获取Doppler Service Token

```bash
# 生成service token (推荐用于CI/CD)
doppler service-tokens create --name=lb-worker-deployment --config=prod

# 输出示例:
# Service Token: dp.st.prod.xxxxxx
# Token ID: st.xxxxxx
# Project: lb-worker
# Config: prod
```

### 步骤 5: 测试集成

```bash
# 加载Doppler配置
source .env.doppler

# 预览模式测试
npm run build:enhanced -- --env=dev --dry-run

# 完整构建测试
npm run build:enhanced -- --env=dev
```

## 🏗️ 部署到不同环境

### 开发环境
```bash
SECRETS_PROVIDER=doppler NODE_ENV=dev npm run deploy:dev
```

### 生产环境
```bash
SECRETS_PROVIDER=doppler NODE_ENV=prod npm run deploy:prod
```

### GitHub Actions集成
```yaml
name: Deploy with Doppler
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Deploy with Doppler
        env:
          SECRETS_PROVIDER: doppler
          DOPPLER_PROJECT: ${{ secrets.DOPPLER_PROJECT }}
          DOPPLER_TOKEN: ${{ secrets.DOPPLER_SERVICE_TOKEN }}
          NODE_ENV: prod
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: npm run deploy:prod
```

## 🔧 高级配置

### Secret过滤
```bash
# 只包含特定secrets
DOPPLER_INCLUDE_SECRETS=QSTASH_CURRENT_SIGNING_KEY,AXIOM_TOKEN

# 排除特定secrets
DOPPLER_EXCLUDE_SECRETS=DEBUG_KEY,TEST_KEY
```

### 自定义API Host
```bash
# 企业版Doppler或自定义endpoint
DOPPLER_API_HOST=https://your-company.doppler.com
```

## 📊 监控和审计

### Doppler Dashboard访问
1. 访问 [https://app.doppler.com](https://app.doppler.com)
2. 选择你的项目 `lb-worker`
3. 查看:
   - **Secrets**: 管理所有secrets
   - **Audit Logs**: 查看访问记录
   - **Service Tokens**: 管理访问token
   - **Configs**: 管理环境配置

### 构建元数据
每次构建后会生成 `secrets-metadata.json`:

```json
{
  "provider": "doppler",
  "environment": "prod",
  "timestamp": "2024-01-16T20:30:00.000Z",
  "secretsCount": 6,
  "project": "lb-worker",
  "config": "prod",
  "validation": {
    "valid": true,
    "errors": [],
    "warnings": []
  }
}
```

## 🛡️ 安全最佳实践

### 1. Token管理
- ✅ 使用Service Token用于CI/CD
- ✅ 定期轮换tokens (90天)
- ✅ 为不同环境创建不同tokens
- ❌ 永远不要将token提交到代码库

### 2. 访问控制
- ✅ 使用最小权限原则
- ✅ 启用audit logs
- ✅ 定期审查访问记录
- ✅ 为自动化系统使用Service Accounts

### 3. 环境隔离
- ✅ 开发/测试/生产环境完全分离
- ✅ 使用不同的Doppler configs
- ✅ 测试环境使用测试secrets

## 🚨 故障排除

### 常见错误及解决方案

#### 错误: `Doppler authentication failed`
```bash
❌ Failed to authenticate with Doppler: Invalid token
```
**解决方案**: 
1. 检查token是否正确: `doppler service-tokens list`
2. 验证token权限: 确保可以访问指定project和config
3. 重新生成token: `doppler service-tokens create`

#### 错误: `Project not found`
```bash
❌ Failed to fetch secrets from Doppler: Project not found
```
**解决方案**:
1. 检查项目名: `doppler projects list`
2. 确保项目名与`DOPPLER_PROJECT`完全匹配
3. 检查拼写和大小写

#### 错误: `Access denied`
```bash
❌ Failed to fetch secrets from Doppler: Access denied
```
**解决方案**:
1. 验证token权限
2. 检查环境映射: `NODE_ENV=dev` → `config=dev`
3. 确认service token状态: `doppler service-tokens list`

### 调试模式

启用详细日志进行调试:
```bash
DEBUG_LOGS=true SECRETS_PROVIDER=doppler npm run build:enhanced -- --env=dev --dry-run
```

## 🔄 从Infisical迁移

如果你已经在使用Infisical，这里是快速迁移步骤:

### 1. 导出现有secrets
```bash
# 从Infisical导出
infisical export --env=prod --format=json > infisical-backup.json
```

### 2. 导入到Doppler
```bash
# 导入到Doppler
doppler secrets import --config=prod infisical-backup.json
```

### 3. 更新配置文件
```bash
# 备份现有配置
cp .env .env.infisical.backup

# 更新为Doppler配置
sed 's/SECRETS_PROVIDER=infisical/SECRETS_PROVIDER=doppler/' .env
sed 's/INFISICAL_PROJECT_ID/DOPPLER_PROJECT/' .env
sed 's/INFISICAL_TOKEN/DOPPLER_TOKEN/' .env
```

### 4. 测试迁移
```bash
# 测试Doppler配置
SECRETS_PROVIDER=doppler npm run build:enhanced -- --env=prod --dry-run

# 验证secrets正确加载
npm test -- --testNamePattern="Doppler"
```

---

🎉 **恭喜！** 你现在已经成功集成了Doppler作为secrets provider。

如果遇到问题，请参考 [完整文档](./DOPPLER_INTEGRATION.md) 或查看 [Doppler官方文档](https://docs.doppler.com)。