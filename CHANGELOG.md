# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

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