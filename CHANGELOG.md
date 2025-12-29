# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [3.2.2](https://github.com/YoungSx/drive-collector-js/compare/v3.2.1...v3.2.2) (2025-12-29)


### 🐛 问题修复

* resolve 429 retry exhaustion on startup with improved rate limiting ([6961c5d](https://github.com/YoungSx/drive-collector-js/commit/6961c5d8d767439225ab904aaa13f6f75a3ea352))

### [3.2.1](https://github.com/YoungSx/drive-collector-js/compare/v3.2.0...v3.2.1) (2025-12-29)


### 📝 文档更新

* update CHANGELOG.md and fix test for release script ([0f5f12a](https://github.com/YoungSx/drive-collector-js/commit/0f5f12a91299e7494f5aa17a350d90241945a1d6))


### ✨ 新特性

* **scripts:** adapt release-ai to latest standards ([b53d6bb](https://github.com/YoungSx/drive-collector-js/commit/b53d6bb4f419281908d52e9a61d6036404ce75d1))

### [3.2.0](https://github.com/YoungSx/drive-collector-js/compare/v3.1.2...v3.2.0) (2025-12-30)

#### ✨ Features

* **DriveRepository**: 实现基于 KV 的活跃网盘列表管理功能，支持 `findAll()` 方法返回所有活跃网盘配置 ([d9c1091](https://github.com/YoungSx/drive-collector-js/commit/d9c109123f5acb5bf468376a80dc78e3db2d612c))

#### 🔧 Refactoring

* **Release Script**: 优化 release-ai.js 与 standard-version 的集成，移除冗余函数，简化发布流程 ([4086754](https://github.com/YoungSx/drive-collector-js/commit/40867549a8429fe82e93fd451d486e149c8ec881))

#### 🐛 Bug Fixes

* **InstanceCoordinator**: 增强锁检查机制，处理 KV 限流和网络错误，避免错误的锁丢失判断
* **Telegram Service**: 改进连接问题处理，在锁检查失败时暂缓重连，防止竞争条件

#### 🔧 Maintenance

* **测试修复**: 更新 DriveRepository 测试以适配新的活跃网盘列表功能
* **配置更新**: 同步更新 manifest.json 中的 driveRepository 配置和可靠性参数

### [3.1.0](https://github.com/YoungSx/drive-collector-js/compare/v3.0.2...v3.1.0) (2025-12-29)


### ✨ Features

* **日志系统**: 添加版本跟踪功能，支持从环境变量或 package.json 动态读取版本号，所有日志消息现在都会包含版本前缀 `[vX.X.X]`，便于问题追踪和版本识别

### 🐛 Bug Fixes

* **发布流程**: 修复 release-ai 脚本问题，确保版本发布流程正常工作
* **Telegram 连接**: 增强 Telegram 锁续期机制，添加双重检查和抖动处理，提升连接稳定性
* **OSS 上传**: 修复在 Node.js 18 环境下 OSS Worker 上传问题，使用 `fs.readFileSync` 替代 `createReadStream`

### 🔧 Maintenance

* **依赖升级**: 升级 Node 运行时至 ^20.0.0，确保依赖兼容性
* **CI/CD 优化**:
  - 移除 Node 18.x 测试矩阵，仅保留 20.x
  - 添加性能指标跟踪到 CI 工作流
  - 实现基于 GitHub App 的自动化 manifest 同步工作流
  - 添加生产环境和 Bark Webhook 配置
  - 增强 GitHub Actions 工作流，包含矩阵测试和 Docker 构建优化

### [3.0.2](https://github.com/YoungSx/drive-collector-js/compare/v3.0.1...v3.0.2) (2025-12-29)


### 📝 文档更新

* add conventional commits guideline to clinerules ([09d0227](https://github.com/YoungSx/drive-collector-js/commit/09d02271e001dd67744428cea3a95b5745778d8b))
* organize CHANGELOG.md: unify format, clear exceptions, and complete 6 missing Git tag versions (v3.0.1~v2.3.5), summarize changes based on commit logs ([fb46627](https://github.com/YoungSx/drive-collector-js/commit/fb466278241accd8298688f54f3594117206059c))
* update clinerules with enhanced guidelines for production quality and manifest sync ([8f70623](https://github.com/YoungSx/drive-collector-js/commit/8f7062324de2bbc4301b736aabc15dbe9f5149c3))


### 🐛 问题修复

* ensure lock ownership during Telegram reconnection and handle AUTH_KEY_DUPLICATED ([fb465a1](https://github.com/YoungSx/drive-collector-js/commit/fb465a16a67fee1b890c530eed762b7284d04d26))
* handle telegram binaryreader undefined stream error ([269bf45](https://github.com/YoungSx/drive-collector-js/commit/269bf45bf79d971ce3a2c85ebcb9e5aa61fc29ce))


### 🔧 其他任务

* bump version to 3.0.1 and enhance release automation ([6be3853](https://github.com/YoungSx/drive-collector-js/commit/6be38531e8017c2d89aad44c807c479d4c611c6b))
* initialize project manifest with architecture blueprint ([c31d59a](https://github.com/YoungSx/drive-collector-js/commit/c31d59ac937c3e970b878e09dd8a29aaf4e419fb))

## [3.0.1] - 2025-12-25

### ✨ Features
- **诊断增强**：添加系统诊断命令，实现诊断报告渲染，增强命令结构。
- **服务管理**：实现 `getAllInstances` 方法，增强实例管理能力。
- **任务队列**：在创建时立即将任务入队到 QStash。

### 🐛 Bug Fixes
- **Telegram 看门狗**：增强看门狗以处理时钟漂移、断开连接状态监控和状态重置。
- **错误处理**：增强错误处理和客户端连接检查。

### 🔧 Maintenance
- **构建流程**：添加条件化镜像推送至 ghcr.io，仅在标签推送时进行条件化构建。
- **日志系统**：用结构化日志服务替换 console.*，提升日志质量。
- **文档更新**：添加 QStash 集成和 Cloudflare LB 文档，添加 .env.example。
- **性能测试**：添加性能测试脚本，优化测试监控。

## [3.0.0] - 2025-12-25

### ✨ Features
- **架构升级**：重大架构重构，将 bot/worker 解耦为 dispatcher/processor，引入 D1 任务队列和 R2 三层上传架构。
- **QStash 集成**：用 QStash 入队替换内部队列，实现分布式任务处理。
- **服务管理**：添加服务管理命令 `/open_service` 和 `/close_service`。
- **Telegram 增强**：添加 Telegram 客户端状态回调和连接管理。

### 🔧 Maintenance
- **依赖更新**：添加 OSS 客户端/存储支持。
- **构建优化**：添加 esbuild 和 wrangler 配置。
- **测试修复**：重构测试以适应新架构，增强错误处理测试。

## [2.4.1] - 2025-12-25

### ✅ Testing
- **测试重构**：更新 TaskManager 测试以使用 DatabaseService，重构 DriveRepository 测试以使用 KV 代替 D1。

## [2.4.0] - 2025-12-25

### ✨ Features
- **架构重构**：将 bot/worker 解耦为 dispatcher/processor，使用 D1 任务队列和 R2 三层上传架构。
- **管理命令**：添加 `/status_public` 和 `/status_private` 管理命令。
- **错误恢复**：为启动和 D1 添加错误处理和重试逻辑，防止启动期间的重入。

### 🔧 Maintenance
- **依赖管理**：添加 esbuild 和 wrangler 用于 Cloudflare Workers 构建。
- **测试优化**：解决 19 个失败的测试并优化执行时间。
- **错误处理**：增强 KVService 错误处理和测试工具。

## [2.3.6] - 2025-12-25

### ✨ Features
- **诊断系统**：实现系统诊断报告渲染，增强诊断报告格式和错误处理。
- **Telegram 连接**：添加连接看门狗和心跳机制，提升连接稳定性。
- **任务显示**：增强聚焦任务的进度显示和任务 ID 显示。

### 🐛 Bug Fixes
- **任务队列 UI**：修复任务队列 UI 稳定性和 TypeError，提升用户体验。
- **文件验证**：改进文件验证和远程大小检测，使用实际本地文件名进行上传验证一致性。
- **错误处理**：增强错误处理和进度条边界，处理重复认证密钥。

### 🔧 Maintenance
- **测试框架**：实现 TaskManager 工作器的重入保护，添加 Dispatcher 回调和消息处理器测试。
- **性能优化**：改进 Rclone 版本解析，简化 UIHelper 状态和进度显示。

## [2.3.5] - 2025-12-25

### ✨ Features
- **任务队列增强**：增强任务队列状态，包含上传处理计数，提升任务监控能力。
- **诊断功能**：添加 `/diagnosis` 命令用于管理员网络诊断，便于问题排查。

### 🐛 Bug Fixes
- **任务管理器稳定性**：修复 TaskManager 中的字符串插值问题，确保消息格式正确。
- **文件验证**：增强文件验证鲁棒性和错误处理，提升系统稳定性。

### 🔧 Maintenance
- **测试增强**：添加 TaskManager 并发和错误处理测试，提升代码质量。
- **文档更新**：从支持的链接类型中移除 Google Drive，更新文档准确性。

## [2.3.4] - 2025-12-25

### 🐛 Bug Fixes

* **任务队列稳定性**：修复了在任务状态频繁变动时可能发生的 `TypeError: Cannot read properties of undefined (reading 'isGroup')` 错误。通过在 `updateQueueUI` 中引入任务快照机制并增加非空检查，显著提升了高并发场景下队列 UI 更新的鲁棒性。

## [2.3.3] - 2025-12-25

### 🐛 Bug Fixes

* **任务监控看板**：修复了在刷新组任务状态时发生的 `ReferenceError: safeEdit is not defined` 错误。通过在 `TaskManager.js` 中正确导入 `safeEdit` 工具函数，确保了媒体组（Album）任务进度的实时更新稳定性。

## [2.3.2] - 2025-12-25


### 🔧 Maintenance

* finalize atomic AIVM workflow for clean git history ([9bf5cd5](https://github.com/YoungSx/drive-collector-js/commit/9bf5cd50a08337109c26e6b8a2057897f199e907))


### ✅ Testing

* 为内存泄漏修复添加测试用例 ([062c8e1](https://github.com/YoungSx/drive-collector-js/commit/062c8e1acb5649739b5206e21b5e2d9f681d4524))


### 🚀 Performance

* 修复内存泄漏风险，在TaskRepository中添加定期清理机制 ([0bccdbc](https://github.com/YoungSx/drive-collector-js/commit/0bccdbcff1487503b7561087b868d25aea1534bb))
* 优化错误处理，移除空的catch块并提供详细错误信息 ([4a34883](https://github.com/YoungSx/drive-collector-js/commit/4a348837a5088bba99fdc4d5a940714ca47e541b))
* 优化缓存策略，基于文件变化频率动态调整缓存时间 ([b63e338](https://github.com/YoungSx/drive-collector-js/commit/b63e33885d3ae5c6fcc8c4f44f58c89ae542c7fc))
* 优化数据库批量操作，在任务恢复时使用批量更新和并发处理 ([616811e](https://github.com/YoungSx/drive-collector-js/commit/616811e4fa6ae94a0017d71b0982797548b67293))
* 优化文件处理，替换同步文件操作为异步操作 ([08b0960](https://github.com/YoungSx/drive-collector-js/commit/08b096099d51eac18317a50cce19e5b68efcf89c))
* 优化限流器性能，消除CPU浪费的while循环 ([1c8156f](https://github.com/YoungSx/drive-collector-js/commit/1c8156f83785a939a4fde97ac20f0a8d3ab4b860))
* 优化循环性能，在updateQueueUI中使用更高效的延迟控制 ([e61d04c](https://github.com/YoungSx/drive-collector-js/commit/e61d04c4c74228dde5c99e5b049342003c673829))
* 优化预加载数据，提升系统启动性能 ([1e5c42b](https://github.com/YoungSx/drive-collector-js/commit/1e5c42b8a28ce0e577d3e9b35c6e6beea581cd1c))
* 优化DriveRepository查询性能 - 为findAll()添加5分钟缓存机制 ([79b1133](https://github.com/YoungSx/drive-collector-js/commit/79b113335062cdceb00db077e27de8988fc2e4ef))
* 优化TaskManager初始化 - 实现异步操作并行化，提升启动性能 ([4390f57](https://github.com/YoungSx/drive-collector-js/commit/4390f575dfcdf37aee1d5bdc4a4582d1e98d9de9))
* 优化TaskManager批量数据库操作 - 添加batchUpdateStatus方法并在组任务完成时使用 ([1644421](https://github.com/YoungSx/drive-collector-js/commit/1644421264fb5b04a9c8293671e8c6fd8fb05d6e))
* 优化UI更新节流机制，基于任务状态和进度动态调整节流时间 ([f69aa58](https://github.com/YoungSx/drive-collector-js/commit/f69aa5857d40d738f4ed0f8288c956ce56c070d6))


### 🐛 Bug Fixes

* 修复测试语法错误，移除不兼容的await import语法 ([846aa3e](https://github.com/YoungSx/drive-collector-js/commit/846aa3e02a9a304c2d674c76a5d80b901d3602f1))
* 修复测试fake timers警告，条件性清理定时器 ([a759423](https://github.com/YoungSx/drive-collector-js/commit/a7594238b694fbfaf47e3360b098b85fcdf0672b))
* 修复所有npm test测试失败问题 ([29fbfce](https://github.com/YoungSx/drive-collector-js/commit/29fbfce5dfdb4cd2aff54e27e0fb6d8e29cff1d5))
* 修复最后的测试失败问题 ([d12845f](https://github.com/YoungSx/drive-collector-js/commit/d12845f28688889e5492a4c3e4229b7640adee36))
* 修复files.slice is not a function错误 ([2221578](https://github.com/YoungSx/drive-collector-js/commit/22215782358136b9bf24a652907ca72eaca87052))
* 修复npm test异步操作清理问题 ([aef32c2](https://github.com/YoungSx/drive-collector-js/commit/aef32c261d37effcc9080149563743e4bc6043d9))
* 重新创建TaskRepository缓存测试文件，修复语法错误 ([9e801d3](https://github.com/YoungSx/drive-collector-js/commit/9e801d3700a66b27530c2d83f29acbbe577afb32))
* **文件列表命令**：修复异步错误中的TypeError，确保文件列表功能正常工作，提升用户体验稳定性。

## [2.3.1] - 2025-12-24

### 🐛 Bug Fixes

* **连接稳定性**：修复Telegram连接超时和数据中心切换问题，大幅提升文件下载的成功率和系统稳定性。通过优化连接参数、重试机制和并发控制，解决了"Not connected"和"File lives in another DC"等常见连接错误。

## [2.3.0] - 2025-12-24

### ✨ Features

* **智能队列分离**：将文件下载和上传流程分离为独立队列，大幅提升系统并发处理能力。下载队列专注处理Telegram文件获取，上传队列专门管理云端转存，两者互不干扰，显著提高了整体处理效率和系统稳定性。

## [2.2.5] - 2025-12-24

### 🐛 Bug Fixes

* **Telegram 连接**: 修复应用启动时的 AUTH_KEY_DUPLICATED 错误，添加自动 Session 清理和重试机制，提升连接稳定性。

## [2.2.4] - 2025-12-24

### ✅ Testing

* **代码文档**: 完善了 TaskRepository 和 D1 服务类的文档注释，提升代码可读性。
* **测试优化**: 调整了相关单元测试用例，确保测试覆盖率的稳定性和准确性。

## [2.2.3] - 2025-12-24

### 🐛 Bug Fixes

* resolve D1 batch error and prevent data loss in flushUpdates ([82d119b](https://github.com/YoungSx/drive-collector-js/commit/82d119b52f6f136a5bcdc74bc2020e838a3510b0))
* sanitize user input and variables in messages to prevent HTML rendering issues ([d6df339](https://github.com/YoungSx/drive-collector-js/commit/d6df339be01c308a320deacc23b64354fcc3e841))

## [2.2.2] - 2025-12-24

### ✅ Testing

* **测试修复**: 修复了 Rclone 批量上传、Telegram 服务和 UI 助手的单元测试用例，解决了依赖冲突和 Mock 不正确的问题，确保 CI/CD 流程的稳定运行。

## [2.2.1] - 2025-12-24

### 🐛 Bug Fixes

* **状态显示**: 修复了在没有等待任务时，系统状态面板中“等待中的任务”数量错误显示为占位符的问题。

## [2.2.0] - 2025-12-24

### ✨ Features
* **欢迎消息**: 优化欢迎消息的排版格式，提升命令列表的可读性。

### 🔧 Maintenance
* **数据库**: 优化 D1 数据库批量操作的错误处理逻辑，提升数据操作的可靠性。

## [2.1.4] - 2025-12-24

### 🐛 Bug Fixes
* **文件列表服务**: 修复了 Rclone `lsjson` 在目录不存在时报错的问题，增强了路径检测的鲁棒性。
* **分发器逻辑**: 解决了 `Dispatcher` 中 `PRIORITY` 变量未定义的 ReferenceError，恢复了 `/files` 命令的正常响应。
* **单元测试**: 修复了 `TaskManager` 和 `CloudTool` 的多个单元测试用例，提高了测试套件的稳定性。

## [2.1.2] - 2025-12-24

### 🔧 Maintenance
* **发布流程革新**: 优化 AI 版本管理规则，实现版本号与 Commit 信息解耦。
* **自动化脚本升级**: 调整 `release-ai` 脚本，支持静默生成与 AI 驱动的总结性提交。

## [2.1.1] - 2025-12-24

### ✨ Features
* **新增帮助菜单**: 实现 `/help` 命令，提供详细的使用指南，并自动显示当前版本号。
* **分发逻辑优化**: 在 `Dispatcher` 中引入 `fs` 和 `path` 模块以支持版本读取。

## [2.1.0] - 2025-12-24

### ✨ Features
* **自动化发布流**: 引入基于 AI 驱动的自动化版本发布工作流，集成 `standard-version` 实现语义化版本管理。
* **限流策略优化**:
    * 引入分布式频率限制与任务优先级调度系统。
    * 实现自适应速率限制（Auto-scaling），动态调整 Telegram Bot API 与 MTProto 的并发数。
    * 增加 Auth 敏感流程的优先级感知限流。
* **多用户架构**:
    * 实现多用户架构及交互式云盘登录，增强租户隔离与安全性。
    * 支持任务持久化与 D1 数据库恢复，确保系统重启后的任务连续性。
* **文件管理增强**:
    * 实现统一的网盘管理与状态监控指令系统。
    * 优化网盘配置流程，支持 `/logout` 注销功能。
    * 引入内存级文件列表缓存，大幅提升分页浏览性能。
* **UI/UX 优化**:
    * 全面优化移动端 UI 布局，引入智能文件名缩写与简洁状态标签。
    * 实时显示上传进度，支持点击文件链接跳转至原始消息。

### 🚀 Performance
* **自适应缩放**: 自动监控 API 成功率并实时调整并发（Bot API: 20-30 QPS, MTProto: 3-8 并发）。
* **下载稳定性**: 将下载块大小提升至 1MB，增强大文件传输的稳定性。
* **缓存系统**: 在 Drive、Settings 和 Task 仓库中全面引入多级缓存机制。

### 🐛 Bug Fixes
* **隔离性修复**: 修复多租户隔离失效问题，通过连接字符串模式确保数据安全。
* **运行时错误**: 解决自适应限流中的 `ReferenceError` 和作用域绑定问题。
* **初始化优化**: 实现非阻塞式初始化，提升机器人启动响应速度。

### ✅ Testing
* **测试覆盖**: 构建完整的单元测试套件，涵盖核心模块、Rclone 服务及 Repository 模式，整体覆盖率显著提升。
* **CI/CD**: 引入自动化测试流水线，确保代码提交质量。

[3.0.1]: https://github.com/YoungSx/drive-collector-js/compare/v3.0.0...v3.0.1
[3.0.0]: https://github.com/YoungSx/drive-collector-js/compare/v2.4.1...v3.0.0
[2.4.1]: https://github.com/YoungSx/drive-collector-js/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/YoungSx/drive-collector-js/compare/v2.3.6...v2.4.0
[2.3.6]: https://github.com/YoungSx/drive-collector-js/compare/v2.3.5...v2.3.6
[2.3.5]: https://github.com/YoungSx/drive-collector-js/compare/v2.3.4...v2.3.5