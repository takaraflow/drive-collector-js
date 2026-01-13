/**
 * 循环日志缓冲区
 * 在高负载情况下防止内存泄漏，自动清理旧日志
 */
export class CircularLogBuffer {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.buffer = [];
    this.totalPushed = 0;
  }

  /**
   * 添加日志条目
   */
  push(item) {
    // 检查是否超过最大大小
    if (this.buffer.length >= this.maxSize) {
      // 移除最旧的条目
      const removeCount = Math.floor(this.maxSize * 0.2); // 移除20%
      this.buffer.splice(0, removeCount);
    }

    this.buffer.push(item);
    this.totalPushed++;
  }

  /**
   * 获取所有日志条目
   */
  getAll() {
    return [...this.buffer];
  }

  /**
   * 清空缓冲区
   */
  clear() {
    this.buffer.length = 0;
  }

  /**
   * 获取缓冲区大小
   */
  get size() {
    return this.buffer.length;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      size: this.size,
      maxSize: this.maxSize,
      totalPushed: this.totalPushed,
      utilizationRate: (this.size / this.maxSize * 100).toFixed(2) + '%'
    };
  }

  /**
   * 检查缓冲区是否已满
   */
  isFull() {
    return this.size >= this.maxSize;
  }

  /**
   * 检查缓冲区是否为空
   */
  isEmpty() {
    return this.size === 0;
  }
}