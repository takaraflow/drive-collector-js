/**
 * 全局日志上下文管理器
 * 适配 CF Workers 环境：轻量级、无状态、按需执行
 */
export class GlobalLogManager {
  constructor(maxContexts = 50, maxContextAge = 300000) {
    this.contexts = new Map();
    this.maxContexts = maxContexts;
    this.maxContextAge = maxContextAge;
    
    // CF Workers 不需要定时器 - 在每次创建上下文时触发清理
    this.lastCleanupTime = Date.now();
  }

  /**
   * 创建新的日志上下文
   * CF Workers 优化：按需清理，避免定时器
   */
  createContext(options) {
    // 按需清理 - 每30秒或每10个上下文创建时清理一次
    const now = Date.now();
    if (now - this.lastCleanupTime > 30000 || this.contexts.size > this.maxContexts * 0.8) {
      this.cleanupExpiredContexts();
      this.lastCleanupTime = now;
    }
    
    const context = new SafeLogContext(options);
    
    // 如果上下文数量超限，强制清理最旧的
    if (this.contexts.size >= this.maxContexts) {
      this.cleanupOldestContext();
    }
    
    this.contexts.set(context.requestId, context);
    return context;
  }

  /**
   * 获取日志上下文
   */
  getContext(requestId) {
    return this.contexts.get(requestId);
  }

  /**
   * 销毁日志上下文
   */
  destroyContext(requestId) {
    const context = this.contexts.get(requestId);
    if (context) {
      context.destroy();
      this.contexts.delete(requestId);
    }
  }

  /**
   * 按需清理过期上下文（CF Workers 优化）
   */
  cleanupExpiredContexts() {
    const now = Date.now();
    const expiredContexts = [];
    
    for (const [requestId, context] of this.contexts.entries()) {
      const age = now - context.startTime;
      if (age > this.maxContextAge) {
        expiredContexts.push(requestId);
      }
    }
    
    // 清理过期上下文
    expiredContexts.forEach(requestId => this.destroyContext(requestId));
    
    if (expiredContexts.length > 0) {
      console.log(`🧹 [GlobalLogManager] 按需清理了 ${expiredContexts.length} 个过期日志上下文`);
    }
  }

  /**
   * 清理最旧的上下文
   */
  cleanupOldestContext() {
    let oldestRequestId = null;
    let oldestTime = Date.now();
    
    for (const [requestId, context] of this.contexts.entries()) {
      if (context.startTime < oldestTime) {
        oldestTime = context.startTime;
        oldestRequestId = requestId;
      }
    }
    
    if (oldestRequestId) {
      this.destroyContext(oldestRequestId);
      console.log(`🧹 [GlobalLogManager] 清理了最旧的日志上下文: ${oldestRequestId}`);
    }
  }

  /**
   * 获取管理器统计信息
   */
  getStats() {
    const contexts = [];
    for (const [requestId, context] of this.contexts.entries()) {
      contexts.push({
        requestId,
        age: Date.now() - context.startTime,
        env: context.env,
        bufferSize: context.logBuffer.size,
        ...context.getStats()
      });
    }
    
    return {
      totalContexts: this.contexts.size,
      maxContexts: this.maxContexts,
      contexts,
      memoryUsage: this.estimateMemoryUsage()
    };
  }

  /**
   * 估算内存使用量
   */
  estimateMemoryUsage() {
    let totalEntries = 0;
    for (const context of this.contexts.values()) {
      totalEntries += context.logBuffer.size;
    }
    
    // 每个日志条目大约 1KB
    const estimatedBytes = totalEntries * 1024;
    return {
      totalEntries,
      estimatedBytes,
      estimatedMB: (estimatedBytes / 1024 / 1024).toFixed(2)
    };
  }

  /**
   * 销毁管理器（CF Workers 版本无需清理定时器）
   */
  destroy() {
    // CF Workers 中无需清理定时器，因为没有启动定时器
    
    // 清理所有上下文
    for (const requestId of this.contexts.keys()) {
      this.destroyContext(requestId);
    }
    
    this.contexts.clear();
    console.log(`🧹 [GlobalLogManager] 销毁管理器，清理了 ${this.contexts.size} 个日志上下文`);
  }
}