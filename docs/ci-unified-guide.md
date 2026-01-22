# CI统一指南

本文档描述了项目中的CI统一逻辑和如何使用改进后的CI系统。

## 概述

CI统一系统将CI工作流逻辑整合到一个可重用的脚本中，支持多种CI模式和本地开发模式。该系统提供了统一的接口来运行验证、测试、构建等CI流程。

## 核心组件

### 1. CI统一脚本 (`scripts/ci-unified.js`)

主要的CI执行脚本，提供以下功能：

- **多种CI模式支持**: full, lint-only, validate-only, test-only, build-only
- **本地和CI环境区分**: 自动检测ACT_LOCAL环境变量
- **性能指标报告**: 详细的执行时间统计
- **错误处理**: 完善的错误处理和回退机制

### 2. CI验证脚本

- `scripts/check-env-manifest.js` - 检查环境变量manifest一致性
- `scripts/check-service-manifest.js` - 检查服务manifest一致性
- `scripts/check-json-duplicates.js` - 检查JSON重复键

### 3. GitHub Actions工作流 (`.github/workflows/ci.yml`)

集成了CI统一脚本的GitHub Actions配置。

## 使用方法

### npm脚本命令

```bash
# 完整CI流程
npm run ci:full

# Manifest同步验证
npm run ci:sync

# Manifest快速验证
npm run ci:validate

# 快速验证 (仅manifest和JSON重复键检查)
npm run ci:quick

# 仅运行lint检查
npm run ci:lint

# 仅运行测试
npm run ci:test

# 仅运行构建
npm run ci:build
```

### 统一入口脚本 (推荐)

为了实现跨平台兼容性和简化调用，推荐使用 `ci/run.sh` 作为统一入口：

```bash
# 完整CI流程 (默认 dev 环境)
bash ci/run.sh full

# 生产环境完整流程
bash ci/run.sh full prod

# 仅验证
bash ci/run.sh validate

# 同步 Manifest
bash ci/run.sh sync
```

### 直接使用脚本

```bash
# 完整CI流程
node scripts/ci-unified.js pipeline

# 仅验证
node scripts/ci-unified.js validate
```

### 环境变量

- `CI_MODE`: 指定CI模式 (full, lint-only, validate-only, test-only, build-only)
- `ACT_LOCAL`: 设置为'true'时启用本地模式
- `NODE_ENV`: 环境变量 (dev, pre, prod)

## CI流程阶段

### 1. 验证阶段
- Manifest文件验证
- JSON重复键检查
- 环境manifest一致性检查
- 服务manifest一致性检查

### 2. 依赖安装阶段
- 根据环境选择npm install或npm ci

### 3. 代码质量检查阶段
- Lint检查
- 格式化检查

### 4. 测试阶段
- 测试套件执行
- 性能测试

### 5. 构建阶段
- Docker镜像构建 (仅本地模式)

### 6. 报告阶段
- 性能指标报告
- 执行时间统计

## 性能优化

### 快速验证模式

使用`ci:quick`命令可以快速验证manifest文件，适合在提交前快速检查：

```bash
npm run ci:quick
```

### 分阶段执行

CI系统支持分阶段执行，可以只运行特定阶段：

```bash
# 仅验证
npm run ci:validate

# 仅lint
npm run ci:lint

# 仅测试
npm run ci:test

# 仅构建
npm run ci:build
```

## 本地开发

### 本地模式

设置`ACT_LOCAL=true`环境变量启用本地模式：

```bash
# 本地完整CI流程
ACT_LOCAL=true npm run ci:full

# 本地Docker构建
ACT_LOCAL=true npm run ci:build
```

### 本地Docker构建

在本地模式下，CI系统会尝试构建Docker镜像：

```bash
# 构建开发环境镜像
ACT_LOCAL=true npm run ci:build dev

# 构建生产环境镜像
ACT_LOCAL=true npm run ci:build prod
```

## GitHub Actions集成

### 工作流配置

GitHub Actions工作流已经集成了CI统一系统：

- `metadata`作业: 运行manifest验证
- `lint`作业: 运行lint和格式化检查
- `test`作业: 运行测试套件
- `build`作业: 构建Docker镜像

### 环境区分

根据分支自动区分环境：

- `main`分支: 生产环境
- `develop`分支: 预发布环境
- 其他分支: 开发环境

## 故障排除

### 常见问题

1. **Manifest验证失败**
   - 检查manifest.json和package.json版本一致性
   - 确保manifest文件语法正确

2. **JSON重复键错误**
   - 使用`npm run check:manifest:duplicates`检查重复键

3. **环境变量缺失**
   - 运行`npm run check:env`检查环境变量配置

4. **Docker构建失败**
   - 确保Docker已安装并运行
   - 检查Dockerfile语法

### 调试模式

启用详细日志输出：

```bash
# 设置调试环境变量
DEBUG_CI=true npm run ci:full
```

## 最佳实践

1. **提交前验证**: 在提交代码前运行`npm run ci:quick`
2. **分阶段测试**: 开发过程中使用分阶段CI命令
3. **性能监控**: 关注CI执行时间，优化慢速测试
4. **环境一致性**: 确保所有环境使用相同的CI流程

## 扩展性

CI统一系统设计为可扩展的架构，可以轻松添加新的验证步骤或测试类型。

如需添加新的CI功能，请修改`scripts/ci-unified.js`文件并更新相应的npm脚本。