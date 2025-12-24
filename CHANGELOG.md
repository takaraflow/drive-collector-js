# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

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