/**
 * 安全的日志上下文
 * 为每个请求提供隔离的日志环境
 */
import { CircularLogBuffer } from './CircularLogBuffer.js';

export class SafeLogContext {
  constructor(options = {}) {
    this.env = options.env || 'unknown';
    this.requestId = options.requestId || this.generateRequestId();
    this.maxBufferSize = options.maxBufferSize || 500;
    this.maxLogAge = options.maxLogAge || 300000; // 5分钟
    this.startTime = Date.now();
    
    // 兼容性处理：如果提供了logBuffer且不是CircularLogBuffer，使用它
    if (options.logBuffer && !options.logBuffer.constructor?.name?.includes('Circular')) {
      this.logBuffer = options.logBuffer;
    } else {
      this.logBuffer = new CircularLogBuffer(this.maxBufferSize);
    }
  }

  /**
   * 生成请求ID
   */
  generateRequestId() {
    return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  }

  /**
   * 添加日志条目
   */
  addLogEntry(entry) {
    // 检查日志年龄，清理过期日志
    this.cleanupOldLogs();
    
    // 添加新日志
    const logEntry = {
      ...entry,
      _meta: {
        timestamp: Date.now(),
        age: Date.now() - this.startTime,
        contextId: this.requestId
      }
    };
    
    // 兼容性处理：如果logBuffer是包装器
    if (this.logBuffer && typeof this.logBuffer.push === 'function') {
      this.logBuffer.push(logEntry);
    } else if (this.logBuffer && this.logBuffer instanceof CircularLogBuffer) {
      this.logBuffer.push(logEntry);
    }

    // 如果缓冲区满，记录警告
    if (this.logBuffer && this.logBuffer.isFull && this.logBuffer.isFull()) {
      console.warn(`⚠️ [SafeLogContext] 日志缓冲区已满 (requestId: ${this.requestId})`);
    }
  }

  /**
   * 清理过期日志
   */
  cleanupOldLogs() {
    const now = Date.now();
    const allLogs = this.logBuffer.getAll();
    
    // 过滤过期日志
    const validLogs = allLogs.filter(log => {
      if (!log._meta) return true;
      return (now - log._meta.timestamp) < this.maxLogAge;
    });

    // 如果有过期日志被清理，重建缓冲区
    if (validLogs.length !== allLogs.length) {
      this.logBuffer.clear();
      validLogs.forEach(log => this.logBuffer.push(log));
    }
  }

  /**
   * 获取所有日志
   */
  getAllLogs() {
    this.cleanupOldLogs();
    return this.logBuffer.getAll();
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.logBuffer.getStats(),
      requestId: this.requestId,
      age: Date.now() - this.startTime,
      env: this.env
    };
  }

  /**
   * 销毁上下文
   */
  destroy() {
    this.clearLogs();
    this.logBuffer = null;
  }

  /**
   * 清空日志
   */
  clearLogs() {
    this.logBuffer.clear();
  }
}
