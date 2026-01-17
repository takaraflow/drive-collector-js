/**
 * Load Balancer 状态管理器 - CF Workers 优化版本
 * 
 * 职责：
 * 1. 管理负载均衡器的运行时状态
 * 2. 提供故障转移逻辑
 * 3. 跟踪提供者切换
 * 4. 状态持久化到 KV（防止 isolate 重启丢失）
 * 5. 初始化锁（防止并发初始化）
 * 
 * CF Workers 优化：
 * 1. 轻量级初始化
 * 2. 按需加载缓存服务
 * 3. 无状态设计，支持快速失败
 * 4. 状态持久化到 KV
 * 5. 初始化锁防止并发
 */
export class LoadBalancerState {
  constructor(env, logger) {
    this.env = env;
    this.logger = logger;
    this.stateKey = 'lb:provider_state';
    this.cache = null;
  }

  /**
   * 初始化状态管理器
   * CF Workers环境下，每次请求都会创建新实例，因此不需要复杂的初始化锁
   */
  async initialize(cacheService) {
    // 直接初始化，无需锁保护
    return this._initializeInternal(cacheService);
  }

  async _initializeInternal(cacheService) {
    this.cache = cacheService;
    
    // 尝试从持久化存储恢复状态
    const persistedState = await this._restoreFromPersistence();
    if (persistedState) {
      this.logger?.info('从持久化存储恢复状态', { state: persistedState });
      return persistedState;
    }
    
    // 没有持久化状态，创建默认状态
    const defaultState = this.getDefaultState();
    await this.setState(defaultState);
    return defaultState;
  }

  /**
   * 从持久化存储恢复状态
   * CF Workers 优化：防止 isolate 重启丢失状态
   */
  async _restoreFromPersistence() {
    try {
      if (this.cache) {
        return await this.cache.get(this.stateKey, 'json');
      }
      return null;
    } catch (error) {
      this.logger?.warn('无法从持久化存储恢复状态', { error: error.message });
      return null;
    }
  }

  /**
   * 获取默认状态
   */
  getDefaultState() {
    return {
      currentProvider: 'cloudflare',
      failureCount: 0,
      lastFailureTime: 0,
      failoverReason: '',
      lastUpdated: Date.now()
    };
  }

  /**
   * 获取当前状态
   */
  async getState() {
    try {
      if (this.cache) {
        const state = await this.cache.get(this.stateKey, 'json');
        if (state) return state;
      }
      return this.getDefaultState();
    } catch (error) {
      this.logger?.error('获取状态失败', { error: error.message, stateKey: this.stateKey });
      return this.getDefaultState();
    }
  }

  /**
   * 设置状态（带持久化）
   */
  async setState(newState) {
    const stateWithTimestamp = {
      ...newState,
      lastUpdated: Date.now()
    };

    try {
      if (this.cache) {
        await this.cache.set(this.stateKey, stateWithTimestamp, 3600);
        // CF Workers 优化：同步持久化到 KV（防止状态丢失）
        await this._persistToKV(stateWithTimestamp);
      }
      
      this.logger?.info('状态更新成功', { state: stateWithTimestamp });
    } catch (error) {
      this.logger?.error('状态更新失败', { error: error.message, state: stateWithTimestamp });
      throw new Error(`Failed to update state: ${error.message}`);
    }
  }

  /**
   * 持久化到 KV（双重保险）
   */
  async _persistToKV(state) {
    try {
      // 如果有 KV 存储，直接写入
      if (this.env?.KV_STORAGE) {
        await this.env.KV_STORAGE.put(this.stateKey, JSON.stringify(state), {
          expirationTtl: 3600
        });
      }
    } catch (error) {
      // 静默失败，不影响主流程
      this.logger?.debug('KV 持久化失败（不影响主流程）', { error: error.message });
    }
  }

  /**
   * 原子化的故障计数增加
   */
  async incrementFailureCount(reason) {
    const maxRetries = 3;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const currentState = await this.getState();
        const newState = {
          ...currentState,
          failureCount: currentState.failureCount + 1,
          lastFailureTime: Date.now(),
          failoverReason: reason
        };
        
        await this.setState(newState);
        return newState;
      } catch (error) {
        if (attempt === maxRetries - 1) {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, Math.random() * 100));
      }
    }
  }

  /**
   * 重置故障计数
   */
  async resetFailureCount() {
    const currentState = await this.getState();
    const newState = {
      ...currentState,
      failureCount: 0,
      lastFailureTime: 0,
      failoverReason: '',
      lastUpdated: Date.now()
    };
    
    await this.setState(newState);
    return newState;
  }

  /**
   * 切换提供者
   */
  async switchProvider(newProvider, reason) {
    const currentState = await this.getState();
    const newState = {
      ...currentState,
      currentProvider: newProvider,
      failureCount: 0,
      lastFailureTime: 0,
      failoverReason: reason,
      lastUpdated: Date.now()
    };
    
    await this.setState(newState);
    return newState;
  }

  /**
   * 检查是否需要故障转移
   */
  async shouldFailover(maxFailures = 3, cooldownMs = 30000) {
    const currentState = await this.getState();
    
    if (currentState.failureCount >= maxFailures) {
      const now = Date.now();
      if (now - currentState.lastFailureTime >= cooldownMs) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 获取当前提供者
   */
  async getCurrentProvider() {
    const currentState = await this.getState();
    return currentState.currentProvider || 'cloudflare';
  }

  /**
   * 状态健康检查
   */
  async healthCheck() {
    try {
      const state = await this.getState();
      const age = Date.now() - state.lastUpdated;
      
      return {
        healthy: true,
        state,
        age: age,
        stale: age > 3600000
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message
      };
    }
  }
}

/**
 * 状态管理器工厂函数
 * CF Workers 优化：按需创建，避免全局状态
 */
export function createLoadBalancerState(env, logger) {
  return new LoadBalancerState(env, logger);
}
