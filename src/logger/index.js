/**
 * 日志模块 - CF Workers 优化版本
 * 
 * 重构原则：
 * 1. 模块化 - 拆分为独立的类和功能
 * 2. 轻量级 - 最小化初始化时间和内存占用
 * 3. 按需执行 - 无定时器，适应 CF Workers 生命周期
 */

// 导出核心日志管理类
export { CircularLogBuffer } from './CircularLogBuffer.js';
export { SafeLogContext } from './SafeLogContext.js';
export { GlobalLogManager } from './GlobalLogManager.js';

// 导入 CF Workers 优化的工厂函数
export { createLoggerFactory } from './createLoggerFactory.js';

// 向后兼容的导出（保持现有 API 不变）
export { flushLogs, sendToAxiom, sanitizeLogData, configureBaseLoggerTransport } from './legacyExports.js';