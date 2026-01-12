/**
 * 本地缓冲队列
 * 提供内存缓冲 + 文件持久化的双重保障
 */

import fs from 'fs/promises';
import path from 'path';

class LocalBufferQueue {
  constructor(options = {}) {
    this.options = {
      maxBufferSize: options.maxBufferSize || 1000,
      flushInterval: options.flushInterval || 5000,
      persistencePath: options.persistencePath || './data/local-queue.json',
      ...options
    };
    
    // 内存缓冲区
    this.buffer = [];
    this.isFlushing = false;
    this.flushTimer = null;
    
    // 状态监控
    this.metrics = {
      totalEnqueued: 0,
      totalFlushed: 0,
      totalFailed: 0,
      currentSize: 0
    };
  }

  /**
   * 初始化队列（恢复持久化数据）
   */
  async init() {
    try {
      // 确保目录存在
      const dir = path.dirname(this.options.persistencePath);
      await fs.mkdir(dir, { recursive: true });
      
      // 尝试恢复数据
      try {
        const data = await fs.readFile(this.options.persistencePath, 'utf8');
        const recovered = JSON.parse(data);
        if (Array.isArray(recovered)) {
          this.buffer = recovered;
          this.metrics.currentSize = recovered.length;
          console.log(`[LocalBufferQueue] 恢复了 ${recovered.length} 条消息`);
        }
      } catch (err) {
        // 文件不存在或损坏，忽略
        if (err.code !== 'ENOENT') {
          console.warn('[LocalBufferQueue] 恢复数据失败:', err.message);
        }
      }
      
      // 启动自动刷新定时器
      this.flushTimer = setInterval(() => {
        this.autoFlush().catch(err => {
          console.error('[LocalBufferQueue] 自动刷新失败:', err);
        });
      }, this.options.flushInterval);
      
    } catch (err) {
      console.error('[LocalBufferQueue] 初始化失败:', err);
      throw err;
    }
  }

  /**
   * 入队（内存缓冲）
   */
  async enqueue(item) {
    if (this.buffer.length >= this.options.maxBufferSize) {
      // 缓冲区满，立即刷新
      await this.flush();
    }
    
    this.buffer.push({
      id: this.generateId(),
      data: item,
      timestamp: Date.now(),
      retryCount: 0
    });
    
    this.metrics.totalEnqueued++;
    this.metrics.currentSize = this.buffer.length;
    
    return true;
  }

  /**
   * 批量入队
   */
  async enqueueBatch(items) {
    for (const item of items) {
      await this.enqueue(item);
    }
    return true;
  }

  /**
   * 手动刷新（持久化到文件）
   */
  async flush() {
    if (this.isFlushing || this.buffer.length === 0) {
      return false;
    }
    
    this.isFlushing = true;
    
    try {
      // 写入文件
      await fs.writeFile(
        this.options.persistencePath,
        JSON.stringify(this.buffer, null, 2),
        'utf8'
      );
      
      console.log(`[LocalBufferQueue] 持久化了 ${this.buffer.length} 条消息`);
      return true;
      
    } catch (err) {
      console.error('[LocalBufferQueue] 持久化失败:', err);
      this.metrics.totalFailed++;
      return false;
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * 自动刷新（由定时器调用）
   */
  async autoFlush() {
    if (this.buffer.length === 0) {
      return;
    }
    
    // 如果缓冲区数据较旧（超过刷新间隔），则刷新
    const oldestTimestamp = this.buffer[0]?.timestamp || 0;
    const now = Date.now();
    
    if (now - oldestTimestamp >= this.options.flushInterval) {
      await this.flush();
    }
  }

  /**
   * 出队并清空缓冲区（消费数据）
   */
  async dequeueBatch() {
    if (this.buffer.length === 0) {
      return [];
    }
    
    const batch = [...this.buffer];
    this.buffer = [];
    this.metrics.totalFlushed += batch.length;
    this.metrics.currentSize = 0;
    
    // 清空持久化文件
    try {
      await fs.writeFile(this.options.persistencePath, '[]', 'utf8');
    } catch (err) {
      console.warn('[LocalBufferQueue] 清空持久化文件失败:', err.message);
    }
    
    return batch;
  }

  /**
   * 获取队列状态
   */
  getStatus() {
    return {
      bufferSize: this.buffer.length,
      metrics: { ...this.metrics },
      isFlushing: this.isFlushing,
      canAccept: this.buffer.length < this.options.maxBufferSize
    };
  }

  /**
   * 重置指标
   */
  resetMetrics() {
    this.metrics = {
      totalEnqueued: 0,
      totalFlushed: 0,
      totalFailed: 0,
      currentSize: 0
    };
  }

  /**
   * 关闭队列（清理资源）
   */
  async close() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    
    // 关闭前刷新剩余数据
    if (this.buffer.length > 0) {
      await this.flush();
    }
    
    console.log('[LocalBufferQueue] 队列已关闭');
  }

  /**
   * 生成唯一ID
   */
  generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 重试失败的消息
   */
  async retryFailed(messageId) {
    const message = this.buffer.find(m => m.id === messageId);
    if (message) {
      message.retryCount++;
      message.timestamp = Date.now();
      return true;
    }
    return false;
  }

  /**
   * 获取重试次数超过阈值的消息
   */
  getExceededRetryMessages(threshold = 3) {
    return this.buffer.filter(m => m.retryCount > threshold);
  }

  /**
   * 移除消息
   */
  removeMessage(messageId) {
    const index = this.buffer.findIndex(m => m.id === messageId);
    if (index !== -1) {
      this.buffer.splice(index, 1);
      this.metrics.currentSize = this.buffer.length;
      return true;
    }
    return false;
  }
}

export { LocalBufferQueue };
export default LocalBufferQueue;