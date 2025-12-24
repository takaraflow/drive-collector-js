# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

### [2.2.5](https://github.com/YoungSx/drive-collector-js/compare/v2.2.3...v2.2.5) (2025-12-24)


### 🐛 问题修复

* **Telegram 连接**: 修复应用启动时的 AUTH_KEY_DUPLICATED 错误，添加自动 Session 清理和重试机制，提升连接稳定性。

### [2.2.4](https://github.com/YoungSx/drive-collector-js/compare/v2.2.3...v2.2.4) (2025-12-24)


### ✅ 质量保障

* **代码文档**: 完善了 TaskRepository 和 D1 服务类的文档注释，提升代码可读性。
* **测试优化**: 调整了相关单元测试用例，确保测试覆盖率的稳定性和准确性。

### [2.2.3](https://github.com/YoungSx/drive-collector-js/compare/v2.2.2...v2.2.3) (2025-12-24)


### 🐛 问题修复

* resolve D1 batch error and prevent data loss in flushUpdates ([82d119b](https://github.com/YoungSx/drive-collector-js/commit/82d119b52f6f136a5bcdc74bc2020e838a3510b0))
* sanitize user input and variables in messages to prevent HTML rendering issues ([d6df339](https://github.com/YoungSx/drive-collector-js/commit/d6df339be01c308a320deacc23b64354fcc3e841))

### [2.2.2](https://github.com/YoungSx/drive-collector-js/compare/v2.2.1...v2.2.2) (2025-12-24)


### ✅ 质量保障

* **测试修复**: 修复了 Rclone 批量上传、Telegram 服务和 UI 助手的单元测试用例，解决了依赖冲突和 Mock 不正确的问题，确保 CI/CD 流程的稳定运行。

### [2.2.1](https://github.com/YoungSx/drive-collector-js/compare/v2.2.0...v2.2.1) (2025-12-24)


### 🐛 问题修复

* **状态显示**: 修复了在没有等待任务时，系统状态面板中“等待中的任务”数量错误显示为占位符的问题。

## [2.2.0](https://github.com/YoungSx/drive-collector-js/compare/v2.1.4...v2.2.0) (2025-12-24)


### ✨ 用户体验
* **欢迎消息**: 优化欢迎消息的排版格式，提升命令列表的可读性。

### 🛡️ 稳定性
* **数据库**: 优化 D1 数据库批量操作的错误处理逻辑，提升数据操作的可靠性。

### [2.1.4](https://github.com/YoungSx/drive-collector-js/compare/v2.1.2...v2.1.4) (2025-12-24)

### 🐛 问题修复
* **文件列表服务**: 修复了 Rclone `lsjson` 在目录不存在时报错的问题，增强了路径检测的鲁棒性。
* **分发器逻辑**: 解决了 `Dispatcher` 中 `PRIORITY` 变量未定义的 ReferenceError，恢复了 `/files` 命令的正常响应。
* **单元测试**: 修复了 `TaskManager` 和 `CloudTool` 的多个单元测试用例，提高了测试套件的稳定性。

### [2.1.2](https://github.com/YoungSx/drive-collector-js/compare/v2.1.1...v2.1.2) (2025-12-24)

### 🔧 规则优化
* **发布流程革新**: 优化 AI 版本管理规则，实现版本号与 Commit 信息解耦。
* **自动化脚本升级**: 调整 `release-ai` 脚本，支持静默生成与 AI 驱动的总结性提交。

### [2.1.1](https://github.com/YoungSx/drive-collector-js/compare/v2.1.0...v2.1.1) (2025-12-24)

### ✨ 核心功能
* **新增帮助菜单**: 实现 `/help` 命令，提供详细的使用指南，并自动显示当前版本号。
* **分发逻辑优化**: 在 `Dispatcher` 中引入 `fs` 和 `path` 模块以支持版本读取。

## 2.1.0 (2025-12-24)

### ✨ 核心功能
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

### 🚀 性能与稳定性
* **自适应缩放**: 自动监控 API 成功率并实时调整并发（Bot API: 20-30 QPS, MTProto: 3-8 并发）。
* **下载稳定性**: 将下载块大小提升至 1MB，增强大文件传输的稳定性。
* **缓存系统**: 在 Drive、Settings 和 Task 仓库中全面引入多级缓存机制。

### 🐛 问题修复
* **隔离性修复**: 修复多租户隔离失效问题，通过连接字符串模式确保数据安全。
* **运行时错误**: 解决自适应限流中的 `ReferenceError` 和作用域绑定问题。
* **初始化优化**: 实现非阻塞式初始化，提升机器人启动响应速度。

### ✅ 质量保障
* **测试覆盖**: 构建完整的单元测试套件，涵盖核心模块、Rclone 服务及 Repository 模式，整体覆盖率显著提升。
* **CI/CD**: 引入自动化测试流水线，确保代码提交质量。