# 标准化 SOP（Manifest / Env / Contract Center）

适用范围：`drive-collector-*` 系列子项目（Node/Worker/Service），用于把“服务能力、端点、ENV、依赖与行为”以统一可校验的方式沉淀到 `manifest.json`，并同步到 `drive-collector-contract`。

目标：
- 单仓库内：代码 ↔ manifest 绝不漂移（能被 CI 阻断）。
- 多仓库间：同名 ENV 字段含义/类型一致，便于统一运维。
- Contract Center：作为唯一事实来源（SSOT），供文档/部署平台/监控读取。

---

## 1. 关键文件约定（每个子项目）

- `manifest.json`
  - 服务对外契约：`endpoints`、`config.env`、`behaviors`、`capabilities`、`runtime` 等。
  - 必须避免重复 key（JSON 会静默覆盖，导致线上配置与预期不一致）。
- `src/config/service-manifest.json`
  - 服务级配置映射与“可热更新/重初始化”的清单（服务维度的补充视图）。
  - 任何 `configKeys` 必须在 `manifest.json config.env` 存在（由脚本校验）。
- `src/config/index.js`
  - 启动时配置加载入口（包含：dotenv 行为、Infisical 拉取、manifest 校验提示、服务重初始化等）。

---

## 2. Env 管理标准（Infisical 启动时动态拉取）

原则：
- secrets 不进入镜像构建层、不在 CI “构建阶段”写入 `.env`。
- 运行时由应用启动逻辑从 Infisical 拉取并注入（平台负责提供最小凭证）。

子项目需要满足：
- `manifest.json:config.env` 必须包含所有运行时读取的 env key（包括 fallback/兼容 key）。
- 本地/CI 不依赖 `.env.prod/.env.pre` 才能通过测试；生产凭证由平台注入。

推荐最小运行时凭证（示例，具体以各项目 manifest 为准）：
- `INFISICAL_TOKEN`
- `INFISICAL_PROJECT_ID`
- `INFISICAL_ENV`（可选：不填则由 `NODE_ENV` 映射）

---

## 3. Endpoints 标准（v2 优先 + legacy 兼容）

原则：
- 新能力一律走 `/api/v2/...`。
- 如需兼容旧路径：在 `manifest.json:endpoints` 增加 `legacy*` 字段用于声明历史路径。

示例（drive-collector-js）：
- `webhookBase: /api/v2/tasks`
- `legacyWebhookBase: /api/tasks`

Contract Center 侧会允许 LB/DC 通过 `legacy*` 做“兼容匹配”，避免升级期互相阻断。

---

## 4. 子项目内的校验与 CI（必须执行）

### 4.1 本地开发自检

在子项目根目录执行：
```bash
# 1) env keys 与代码引用对齐
npm run check:env

# 2) manifest JSON 重复 key 检查
npm run check:manifest:duplicates

# 3) 单元测试（推荐 coverage）
npm run test:coverage
```

### 4.2 子项目 CI 要求

子项目 CI 应至少包含：
- `npm run check:env`
- `npm run check:manifest:duplicates`
- `npm run test:coverage`

并且：
- lint/format 只有在 `package.json` 存在对应 script 时才执行；一旦执行必须成功（不能用 “失败也绿”）。
- 构建镜像时不要通过 build-args 传入 Infisical 凭证（避免泄露到 build log/layer）。

---

## 5. 与 Contract Center 的交互（同步机制）

### 5.1 子项目侧（drive-collector-js）

当 `manifest.json` 发生变更时，触发 `.github/workflows/sync-manifest.yml`：
- 将 `manifest.json` 复制到 `drive-collector-contract/registry/<repo>.json`
- 由 contract 仓库的校验规则决定是否允许合入（建议启用 PR + 分支保护）

注意：
- 同步前先通过子项目自身的 `check:env` / `check:manifest:duplicates`，避免坏 manifest 扩散。

### 5.2 Contract Center 侧（drive-collector-contract）

Contract Center 必须提供：
- schema 校验：`schemas/v1.1.json` + `scripts/validate.js`
- registry 规则校验（建议包含）：
  - `registry/<name>.json` 文件名与 manifest `id` 强一致
  - JSON duplicate keys 检测（阻断）
  - 若 capability 含 `qstash-webhook`：强制 `endpoints.webhookBase` 使用 `/api/v2/*`
  - ENV 标准目录：`catalog/common-env.json`（同名 key type 必须一致）

并在 GitHub 开启分支保护（required checks）：
- `Validate Contracts` 必须通过才能 merge 到 `main`。

---

## 6. 新子项目接入 SOP（Checklist）

### 6.1 子项目初始化

- [ ] 根目录创建 `manifest.json`（字段至少包含：`id/name/version/type/endpoints/config.env/runtime`）
- [ ] 代码中所有 `process.env.*` / `env.*` 引用都纳入 `manifest.json config.env`
- [ ] 如有服务重初始化/动态配置：补 `src/config/service-manifest.json` 并确保 `configKeys` 都在 manifest 内
- [ ] 加入校验脚本到 `package.json scripts`：
  - `check:env:manifest` / `check:env:service-manifest` / `check:env`
  - `check:manifest:duplicates`
- [ ] CI 执行：`npm run check:env` + `npm run check:manifest:duplicates` + `npm run test:coverage`

### 6.2 接入 Contract Center

- [ ] 在子项目仓库配置 `sync-manifest.yml`（只在 `manifest.json` 变更时触发）
- [ ] `drive-collector-contract` 中新增/更新：
  - `registry/<repo>.json`
  - 如新项目引入通用 env key：补充 `catalog/common-env.json`
- [ ] 确认 `drive-collector-contract` 的 `Validate Contracts` 对该项目通过

---

## 7. 常见问题与处理

### 7.1 “manifest 有重复 key 警告/线上行为异常”
- 先跑：`npm run check:manifest:duplicates`
- 修复重复字段（JSON 会“后者覆盖前者”，导致你以为生效的配置其实被覆盖）

### 7.2 “新增 env，但 CI 报 manifest 缺失”
- 搜索代码里新增的 `process.env.X` / `env.X`
- 将 `X` 加入 `manifest.json:config.env`
- 如果它属于跨仓库通用 key，再同步补进 `drive-collector-contract/catalog/common-env.json`

### 7.3 “endpoints 缺 v2 / LB 与 DC 不一致”
- manifest 中 v2 为主：`/api/v2/...`
- 旧路径写入 `legacy*` 字段
- contract 侧会做兼容匹配，但最终建议推动所有组件迁移到 v2

---

## 8. 维护策略（长期）

- 以 Contract Center 为 SSOT：其他系统（部署平台/文档/运维面板）只读取 contract。
- 逐步收紧标准：
  - 第一阶段：只强制“字段存在+类型一致+无重复 key”
  - 第二阶段：收紧 required、端点规范、能力声明与行为说明一致性

