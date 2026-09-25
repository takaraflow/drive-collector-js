/**
 * 请求超时控制器 - CF Workers 优化版本
 * 
 * 职责：
 * 1. 管理请求超时
 * 2. 提供 AbortController 集成
 * 3. 自动清理超时任务
 * 
 * CF Workers 优化：
 * 1. 轻量级实现
 * 2. 零依赖
 * 3. 自动内存管理
 */
export class RequestTimeoutController {
  /**
   * 创建超时控制器
   * @param {number} timeoutMs - 超时时间（毫秒）
   * @param {Object} options - 选项
   */
  constructor(timeoutMs = 10000, options = {}) {
    this.timeoutMs = timeoutMs;
    this.options = {
      onTimeout: options.onTimeout || (() => {}),
      signal: options.signal || null
    };
    
    this.abortController = new AbortController();
    this.timeoutId = null;
    this.started = false;
  }

  /**
   * 启动超时计时器
   */
  start() {
    if (this.started) {
      return this;
    }
    
    this.started = true;
    this.timeoutId = setTimeout(() => {
      this.abortController.abort();
      this.options.onTimeout?.(this.timeoutMs);
    }, this.timeoutMs);
    
    return this;
  }

  /**
   * 获取 Signal（用于 fetch 等）
   */
  get signal() {
    return this.abortController.signal;
  }

  /**
   * 取消超时
   */
  cancel() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.started = false;
    return this;
  }

  /**
   * 销毁控制器
   */
  destroy() {
    this.cancel();
    this.abortController = null;
  }
}

/**
 * 超时中间件工厂
 * @param {number} defaultTimeout - 默认超时时间
 */
export function createTimeoutMiddleware(defaultTimeout = 10000) {
  return function timeoutMiddleware(handler) {
    return async function timeoutHandler(request, env, ctx) {
      const timeoutController = new RequestTimeoutController(defaultTimeout, {
        onTimeout: () => {
          console.warn(`⚠️ [Timeout] 请求超时 (${defaultTimeout}ms): ${request.url}`);
        }
      });
      
      // 将超时控制器添加到 ctx（如果支持）
      if (ctx && typeof ctx === 'object') {
        ctx.timeoutController = timeoutController;
      }
      
      try {
        timeoutController.start();
        return await handler(request, env, ctx);
      } finally {
        timeoutController.cancel();
      }
    };
  };
}

/**
 * 带超时的 fetch
 * @param {string} url - URL
 * @param {Object} options - 选项
 * @param {number} timeout - 超时时间
 */
export async function fetchWithTimeout(url, options = {}, timeout = 10000) {
  const controller = new RequestTimeoutController(timeout);
  controller.start();
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    controller.cancel();
  }
}

/**
 * 创建可取消的任务
 * @param {Function} task - 任务函数
 * @param {number} timeout - 超时时间
 */
export function createCancellableTask(task, timeout = 10000) {
  const controller = new RequestTimeoutController(timeout);
  
  return {
    run: async (...args) => {
      controller.start();
      try {
        return await task(...args);
      } finally {
        controller.cancel();
      }
    },
    cancel: () => controller.cancel(),
    get signal() {
      return controller.signal;
    }
  };
}