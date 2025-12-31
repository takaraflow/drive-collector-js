# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

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