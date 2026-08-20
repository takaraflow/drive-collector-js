💡 内容
- 在 \`TaskRepository\` 中优化使用 \`d1.batch()\` 执行相关的 N+1 获取查询，如 \`getUserQueueOverview\`, \`getQueueOverview\`, \`getTasksByStatus\`。

🎯 原因
- 通过利用 D1 批量查询，显著减少请求的 HTTP I/O 和延迟。
- 先前代码使用了 \`Promise.all(d1.fetchAll(...))\`，此模式会导致每个语句都会触发独立的 HTTP 请求，影响批量查询时的整体响应速度。这属于架构级别的瓶颈解决。

📊 影响
- N+1 I/O 网络请求降低。提升应用对 D1 数据库的数据聚合查询速度。

🔬 测试
- 执行了完整的本地单元测试 (\`pnpm run ci:test\`) 且 \`__tests__/repositories/TaskRepository.test.js\` 全部通过。
