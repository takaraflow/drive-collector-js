# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [0.7.7](https://github.com/YoungSx/lb-worker-js/compare/v0.7.6...v0.7.7) (2026-01-02)


### 🐛 Bug Fixes

* correct Axiom exporter headers configuration by removing optional Org ID ([f0cfd47](https://github.com/YoungSx/lb-worker-js/commit/f0cfd47f76b50a52884528331c08c4ccf5637ad1))

### [0.7.6](https://github.com/YoungSx/lb-worker-js/compare/v0.7.5...v0.7.6) (2026-01-02)


### 🐛 Bug Fixes

* simplifies logging implementation and removes Axiom integration ([5ee1ca2](https://github.com/YoungSx/lb-worker-js/commit/5ee1ca2f5c21ee1f56ec4e132a434b686e58d453))

### [0.7.5](https://github.com/YoungSx/lb-worker-js/compare/v0.7.4...v0.7.5) (2026-01-02)


### 🐛 Bug Fixes

* dynamically parse GHA JSON for infra vars ([cbf1049](https://github.com/YoungSx/lb-worker-js/commit/cbf10495be75a96aad4a5ec5e42be1558a3757a7))
* improve Jest configuration and build process reliability ([b16f14f](https://github.com/YoungSx/lb-worker-js/commit/b16f14f4ed36326395851a61c90ece5f0e0d676a))
* replaces build.sh with cross-platform Node.js build logic ([6355e54](https://github.com/YoungSx/lb-worker-js/commit/6355e5415aea523dd1c94baa9b8f23b0ead03a0b))

### [0.7.4](https://github.com/YoungSx/lb-worker-js/compare/v0.7.3...v0.7.4) (2026-01-02)


### ✨ Features

* support full business vars in wrangler.toml during local build ([f1660ea](https://github.com/YoungSx/lb-worker-js/commit/f1660eabd170ade9b121b55103704ad607234364))


### 🐛 Bug Fixes

* improve test stability and deployment configuration ([6ae2793](https://github.com/YoungSx/lb-worker-js/commit/6ae2793194f22a2135e1d71e50e47fb038a47cc6))
* optimize generate-wrangler-vars.test.js performance, remove real IO and use fake timers/mocks ([ae9887b](https://github.com/YoungSx/lb-worker-js/commit/ae9887b42a39aa801960b00b0927fdeae98bd95b))
* updates WORKER_NAME default to use package.json name ([1dd73c7](https://github.com/YoungSx/lb-worker-js/commit/1dd73c7ff5b3c9b32812885839048295159ad37c))

### [0.7.3](https://github.com/YoungSx/lb-worker-js/compare/v0.7.2...v0.7.3) (2026-01-02)

### [0.7.2](https://github.com/YoungSx/lb-worker-js/compare/v0.7.1...v0.7.2) (2026-01-02)


### 🐛 Bug Fixes

* resolve process.env TS error in Worker context ([bdcc488](https://github.com/YoungSx/lb-worker-js/commit/bdcc488221e0a24172f83bd4f8a12a635658fcde))
* update @opentelemetry/api to exact version and add overrides ([2cce5ec](https://github.com/YoungSx/lb-worker-js/commit/2cce5ec30570422429080595dcdaa703fc2ac67d))
* updates build script to use dynamic version from package.json ([154982c](https://github.com/YoungSx/lb-worker-js/commit/154982c05f79503b80ec0600df6f63fc6524312b))

### [0.7.1](https://github.com/YoungSx/lb-worker-js/compare/v0.7.0...v0.7.1) (2026-01-02)


### 🐛 Bug Fixes

* updates Redis health check to use HTTP-based provider ([2e144c1](https://github.com/YoungSx/lb-worker-js/commit/2e144c1ef0472d360be4dd79349cd98378364f6d))

## [0.7.0](https://github.com/YoungSx/lb-worker-js/compare/v0.6.0...v0.7.0) (2026-01-02)


### 🔧 Maintenance

* implement Redis TCP client with enhanced reliability ([293f4b9](https://github.com/YoungSx/lb-worker-js/commit/293f4b91051c38b7c44afc2538d09e5de06fc1ed))


### 🐛 Bug Fixes

* improve Redis connection reliability and add TLS workaround ([223f28b](https://github.com/YoungSx/lb-worker-js/commit/223f28bbffe1e3ba35a1800ad92d704ab79887fd))
* improves Redis command retry logic and adds timeout handling ([b241d69](https://github.com/YoungSx/lb-worker-js/commit/b241d69b8e96559c68f8e88d8aa3d49785e48cc6))
* updates Redis client initialization with improved TLS configuration ([b1cdad1](https://github.com/YoungSx/lb-worker-js/commit/b1cdad1c68733fa4f96b99702c41a7d4cd58574c))

## [0.6.0](https://github.com/YoungSx/lb-worker-js/compare/v0.5.0...v0.6.0) (2026-01-01)


### ✨ Features

* **gha:** dynamic wrangler vars generation from manifest.json ([0341828](https://github.com/YoungSx/lb-worker-js/commit/0341828a4a6d50d6a36466f9ab7a193f45310e34))
* **gha:** ultimate dynamic secrets/vars import via GHA context JSON ([5659f9f](https://github.com/YoungSx/lb-worker-js/commit/5659f9fbf0a60492b1a0d0526ac490ff94c24d4b))


### 🐛 Bug Fixes

* **gha:** add NF_REDIS_PASSWORD and NF_REDIS_URL to deploy workflow ([c2a5d0c](https://github.com/YoungSx/lb-worker-js/commit/c2a5d0cf860f8dd307693289af7f9f2bd6620a86))
* **gha:** remove hardcoded env list from deploy workflow ([5c93e58](https://github.com/YoungSx/lb-worker-js/commit/5c93e58f78925fb69366a3bb6858b7d48c0e3638))

## [0.5.0](https://github.com/YoungSx/lb-worker-js/compare/v0.4.3...v0.5.0) (2026-01-01)


### 🔧 Maintenance

* replace NF_REDIS_TOKEN to NF_REDIS_PASSWORD ([0ea6bc2](https://github.com/YoungSx/lb-worker-js/commit/0ea6bc2865e046baf4c9ec94246564321bc2a55e))

### [0.4.3](https://github.com/YoungSx/lb-worker-js/compare/v0.4.2...v0.4.3) (2026-01-01)


### ✨ Features

* add Axiom logging integration and diagnostic capabilities ([2b86720](https://github.com/YoungSx/lb-worker-js/commit/2b86720007e346350daf8d4cf544acf9092a5f3b))

### [0.4.2](https://github.com/YoungSx/lb-worker-js/compare/v0.4.1...v0.4.2) (2026-01-01)


### 🐛 Bug Fixes

* improves logging consistency and error handling in Redis operations ([ceadfb9](https://github.com/YoungSx/lb-worker-js/commit/ceadfb9357999ce3acd25c9bf959446e559ddb49))

### [0.4.1](https://github.com/YoungSx/lb-worker-js/compare/v0.4.0...v0.4.1) (2026-01-01)

## [0.4.0](https://github.com/YoungSx/lb-worker-js/compare/v0.3.1...v0.4.0) (2026-01-01)


### 🐛 Bug Fixes

* adds missing wrangler.toml to .gitignore and improves build validation ([65fb1d2](https://github.com/YoungSx/lb-worker-js/commit/65fb1d2b64e9a37f4171eb778aad345c8fc1cb05))
* build ([fca3a61](https://github.com/YoungSx/lb-worker-js/commit/fca3a615aaa344a7173a4592fa9339cdd5d27321))
* build error ([b832cf7](https://github.com/YoungSx/lb-worker-js/commit/b832cf7d986ec7bf0b810f660083076aebefca04))
* correct syntax error in jest.config.js moduleNameMapper ([c5fcf8e](https://github.com/YoungSx/lb-worker-js/commit/c5fcf8e5079a9ce116ba6af2f391fd1c7dfe873e))
* standardize env vars, migrate from wrangler.toml to .env, fix NF_REDIS config, update types ([d2ef91d](https://github.com/YoungSx/lb-worker-js/commit/d2ef91dd53c1c74118c011b21402adc2d918cfbc))


### ✨ Features

* add test:optimized and test:full-optimized scripts to package.json ([3c358af](https://github.com/YoungSx/lb-worker-js/commit/3c358af50ce3f9d8612ecf29f635c2af285e7de2))
* adds provider priority system with NF Redis > CF KV > Upstash fallback ([aff7d63](https://github.com/YoungSx/lb-worker-js/commit/aff7d631123a9f43b5afeee6e239186415860f2f))
* supplement missing NF Redis, legacy Redis, and R2 environment variables in manifest, env.example, and wrangler files ([3b0447b](https://github.com/YoungSx/lb-worker-js/commit/3b0447bebf40a80a2172601a3b6cdc9a6dab36ee))
* sync .clinerules with drive-collector-js standards ([9026dff](https://github.com/YoungSx/lb-worker-js/commit/9026dffbe92e4e81463710c6f76011d0909a222f))
* upgrade jest.config.js with performance optimizations from drive-collector-js ([0c67bc2](https://github.com/YoungSx/lb-worker-js/commit/0c67bc28a80e9f6f550c1cace3c5e66809da8567))

### [0.3.1](https://github.com/YoungSx/lb-worker-js/compare/v0.3.0...v0.3.1) (2025-12-31)


### 🐛 Bug Fixes

* wrangler ([9548252](https://github.com/YoungSx/lb-worker-js/commit/9548252036342e9fceb57a79c2f5d9ae6b5802f1))

## [0.3.0](https://github.com/YoungSx/lb-worker-js/compare/v0.2.1...v0.3.0) (2025-12-31)


### 🔧 Maintenance

* adds path normalization and Northflank/Cloudflare cache configurations ([591fc2a](https://github.com/YoungSx/lb-worker-js/commit/591fc2a41dfca92c46cb3cf04480b6b41ed4168d))

### [0.2.1](https://github.com/YoungSx/lb-worker-js/compare/v0.2.0...v0.2.1) (2025-12-31)


### ✨ Features

* add version tracking to build and logging system ([ce04abf](https://github.com/YoungSx/lb-worker-js/commit/ce04abf6fb20b270ea339d281a7ed514e807dfd4))


### 🐛 Bug Fixes

* enhances logging and health check with structured output ([308f846](https://github.com/YoungSx/lb-worker-js/commit/308f846348c4459a9cad9b1ad1e213a3805d6621))
* health ([7b06466](https://github.com/YoungSx/lb-worker-js/commit/7b0646654c91ec41705cbd304d5f23155bfa2692))

## [0.2.0](https://github.com/YoungSx/lb-worker-js/compare/v0.1.6...v0.2.0) (2025-12-31)


### ✨ Features

* add native Axiom logs batching, retain OTel traces, fix semantic fields ([4baddfd](https://github.com/YoungSx/lb-worker-js/commit/4baddfd6355b1037fa9bd5694d29db4bb7167087))
* adds consistent instanceId to tracing events ([e2ecc70](https://github.com/YoungSx/lb-worker-js/commit/e2ecc7070e0521fa40818e4f62f8ca7e1cf15cca))

### [0.1.6](https://github.com/YoungSx/lb-worker-js/compare/v0.1.5...v0.1.6) (2025-12-31)


### ✅ Testing

* add body log ([de736b3](https://github.com/YoungSx/lb-worker-js/commit/de736b34fa810185c582a279d8e5ff88f1c8a8ba))


### 🔧 Maintenance

* refactors OpenTelemetry initialization to use static imports and instrumentation wrapper ([56e9b16](https://github.com/YoungSx/lb-worker-js/commit/56e9b1655f3c129e5afba50f2c5b5860e523d611))
* updates QStash import path to use Cloudflare-specific module ([2064e20](https://github.com/YoungSx/lb-worker-js/commit/2064e208c6f1d65c95082e243129e51a91173e5b))


### 🐛 Bug Fixes

* axiom ([73f1126](https://github.com/YoungSx/lb-worker-js/commit/73f1126befa8ef14aff4e59c9f5fbc5128c862e4))
* enables replay protection bypass for QStash signature verification ([4a13f38](https://github.com/YoungSx/lb-worker-js/commit/4a13f38148192cb8e3d0bd5c2de811bca776bafe))
* logger ([5a95b79](https://github.com/YoungSx/lb-worker-js/commit/5a95b79c106ebcf118d03e270c375f59d6da8b3c))
* manual timestamp expiration check in verifyQStashSignature ([0ef9890](https://github.com/YoungSx/lb-worker-js/commit/0ef9890fcba9195ec61df43ddd46fc5e8fbf8fb0))
* OTel library crash when accessing undefined env variables ([721772c](https://github.com/YoungSx/lb-worker-js/commit/721772cf9ab2caf874dc60db3f2358ca2f736ef6))
* resolve global reference and qstash signature verification in CF Worker ([265d75f](https://github.com/YoungSx/lb-worker-js/commit/265d75f7069ac08b1974b446472b330534c97bec))
* sign ([9268118](https://github.com/YoungSx/lb-worker-js/commit/92681181122866e73016ae05a1fdf68ada9829fa))
* update QStash dependency and improve signature verification ([26ab01f](https://github.com/YoungSx/lb-worker-js/commit/26ab01f58049d964d22e45d362905d24c996da6c))

### [0.1.5](https://github.com/YoungSx/lb-worker-js/compare/v0.1.4...v0.1.5) (2025-12-30)

### [0.1.4](https://github.com/YoungSx/lb-worker-js/compare/v0.1.3...v0.1.4) (2025-12-30)

### [0.1.2](https://github.com/YoungSx/lb-worker-js/compare/v0.1.1...v0.1.2) (2025-12-29)


### 📝 Documentation

* update CHANGELOG.md for v0.1.1 release ([b8f63af](https://github.com/YoungSx/lb-worker-js/commit/b8f63aff8721b3abe17227a5326dcd5423b2a68a))


### 🐛 Bug Fixes

* improve sync-manifest workflow with better error handling and variable usage ([fd3cc8a](https://github.com/YoungSx/lb-worker-js/commit/fd3cc8abbdf9ded52205cf14c9cc342674f340c2))

## [0.1.1] - 2025-12-29

### Added
- **自动同步工作流**：新增 GitHub Actions 工作流，自动同步版本更新到 manifest.json。
- **manifest 验证增强**：完善 manifest.json 的 schema 验证和自动化测试。

### Changed
- **发布流程优化**：集成 AI 增强的发布脚本，自动处理版本同步和文件更新。
- **CI/CD 配置**：优化 GitHub Actions 工作流配置，提升部署可靠性。

## [1.1.0] - 2025-12-29

### Added
- **精细化任务调度失败处理策略**：
  - 无活跃实例时返回 **503 Service Unavailable** + `Retry-After: 60` 头部，指导 QStash 退避重试。
  - 实例返回 **4xx** 错误时直接透传并停止重试其他实例，避免无效重试循环。
  - 所有实例返回 **5xx** 时透传最后一个 5xx 响应，允许 QStash 继续重试。
- **增强日志记录**：所有错误场景中记录 `Upstash-Message-Id` 和 `Upstash-Retries` 元数据，提升可观测性和调试能力。
- **新增 LBError 类**：用于精细化错误处理，区分业务错误和内部错误。
- **完整测试覆盖**：新增 `tests/new-features.test.js`，覆盖 4xx 停止重试、5xx 透传、QStash 元数据记录和 Retry-After 头部等场景，确保 100% 测试通过。

### Changed
- **src/index.js**：优化转发逻辑，集成 LBError 类，更新状态码和头部处理，增强日志输出。
- **tests/index.test.js**：更新现有测试以兼容新逻辑，确保所有测试通过。

### Fixed
- 修复了之前所有错误统一返回 500 的问题，避免误导 QStash 重试策略。
- 修复了缺乏 QStash 元数据记录的问题，提升生产环境调试效率。

### Migration Notes
- **无需手动重新塞回 QStash**：LB 现在通过 HTTP 状态码和头部指导 QStash 自动重试，无需额外干预。
- **日志监控**：建议在生产环境中监控 `Upstash-Message-Id` 和 `Upstash-Retries` 日志，以跟踪重试行为。
- **死信队列 (DLQ)**：QStash 会自动处理 4xx 错误进入 DLQ，无需 LB 额外配置。

## [1.0.0] - Initial Release
- 基础负载均衡器功能：从 KV 存储获取实例列表，转发请求到活跃实例。
- 支持健康检查和基本错误处理。