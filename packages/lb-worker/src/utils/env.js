import { ENV_ALIASES, ENV_KEYS } from '../config/constants.js';

/**
 * 规范化环境名称
 * @param {string} value - 环境变量值
 * @returns {string} - 规范化后的环境名称
 */
export function normalizeEnvName(value = 'prod') {
  const key = String(value || '').toLowerCase();
  return ENV_ALIASES[key] || key || 'prod';
}

/**
 * 创建安全的环境对象
 * 修复 @microlabs/otel-cf-workers 库的 Bug
 * 该库在拦截环境变量访问时，如果值为 undefined 会导致 isKVNamespace 函数报错
 * TypeError: Cannot read properties of undefined (reading 'getWithMetadata')
 * 
 * @param {Object} env - 原始环境对象
 * @returns {Proxy} - 安全的环境代理对象
 */
export function createSafeEnv(env) {
  return new Proxy(env || {}, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      // 如果值为 undefined，返回空字符串
      // 这样 isKVNamespace checks (value.getWithMetadata) 会变成 undefined (safe)
      // 且空字符串是 falsy 值，不影响一般的 if (env.VAR) 判断
      if (value === undefined) {
        return "";
      }
      return value;
    }
  });
}

/**
 * 检测缓存提供者
 * @param {Object} env - 环境对象
 * @returns {string} - 缓存提供者类型
 */
export function detectCacheProvider(env) {
  if (env.CACHE_PROVIDERS) return env.CACHE_PROVIDERS;
  const prios = getProviderPriority(env);
  return prios[0] || 'none';
}

/**
 * 获取提供者优先级 (使用 CACHE_PROVIDERS)
 * @param {Object} env - 环境对象
 * @returns {Array<string>} - 优先级列表
 */
export function getProviderPriority(env) {
  const prios = [];
  if (env.KV_STORAGE) prios.push('cloudflare');
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) prios.push('upstash');
  return prios;
}

/**
 * 描述 Redis 端点（用于日志）
 * @param {Object} env - 环境对象
 * @returns {string} - 端点描述
 */
export function describeRedisEndpoint(env) {
  return 'using CACHE_PROVIDERS';
}

/**
 * 检查是否为测试环境
 * @param {Object} env - 环境对象（可选）
 * @returns {boolean} - 是否为测试环境
 */
export function isTestEnvironment(env) {
  // 检查全局变量和环境变量
  if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV) {
    const nodeEnv = process.env.NODE_ENV.toLowerCase();
    return nodeEnv === 'test' || nodeEnv === 'testing';
  }
  
  // 检查全局测试标志
  if (typeof globalThis !== 'undefined' && globalThis.__TEST_ENV__) {
    return true;
  }
  
  // 检查传入的 env 对象
  if (env && env.NODE_ENV) {
    const envNodeEnv = String(env.NODE_ENV).toLowerCase();
    return envNodeEnv === 'test' || envNodeEnv === 'testing';
  }
  
  return false;
}

/**
 * 获取环境变量值（带默认值和验证）
 * @param {Object} env - 环境对象
 * @param {string} key - 环境变量键名
 * @param {any} defaultValue - 默认值
 * @param {Function} validator - 验证函数（可选）
 * @returns {any} - 环境变量值或默认值
 */
export function getEnvValue(env, key, defaultValue = null, validator = null) {
  const value = env[key];
  
  // 如果值不存在，返回默认值
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  
  // 如果有验证函数，进行验证
  if (validator && !validator(value)) {
    return defaultValue;
  }
  
  return value;
}

/**
 * 检查必需的环境变量
 * @param {Object} env - 环境对象
 * @param {Array<string>} requiredKeys - 必需的环境变量键名列表
 * @returns {Object} - 检查结果 { isValid: boolean, missing: string[] }
 */
export function validateRequiredEnv(env, requiredKeys) {
  const missing = [];
  
  for (const key of requiredKeys) {
    const value = env[key];
    if (value === undefined || value === null || value === '') {
      missing.push(key);
    }
  }
  
  return {
    isValid: missing.length === 0,
    missing
  };
}

/**
 * 获取布尔类型的环境变量
 * @param {Object} env - 环境对象
 * @param {string} key - 环境变量键名
 * @param {boolean} defaultValue - 默认值
 * @returns {boolean} - 布尔值
 */
export function getBooleanEnv(env, key, defaultValue = false) {
  const value = env[key];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  
  const strValue = String(value).toLowerCase();
  return strValue === 'true' || strValue === '1' || strValue === 'yes';
}

/**
 * 获取数字类型的环境变量
 * @param {Object} env - 环境对象
 * @param {string} key - 环境变量键名
 * @param {number} defaultValue - 默认值
 * @returns {number} - 数字值
 */
export function getNumberEnv(env, key, defaultValue = 0) {
  const value = env[key];
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  
  const num = Number(value);
  return isNaN(num) ? defaultValue : num;
}

/**
 * 检查 Axiom 配置是否有效
 * @param {Object} env - 环境对象
 * @param {boolean} isTest - 是否为测试环境
 * @returns {boolean} - Axiom 是否启用
 */
export function isAxiomEnabled(env, isTest = false) {
  if (isTest) return false;
  
  const hasToken = env.AXIOM_TOKEN && env.AXIOM_TOKEN.trim() !== '';
  const hasDataset = env.AXIOM_DATASET && env.AXIOM_DATASET.trim() !== '';
  
  return hasToken && hasDataset;
}

/**
 * 获取 Axiom 配置对象
 * @param {Object} env - 环境对象
 * @returns {Object|null} - Axiom 配置或 null
 */
export function getAxiomConfig(env) {
  if (!isAxiomEnabled(env)) {
    return null;
  }
  
  const config = {
    url: 'https://api.axiom.co/v1/traces',
    headers: {
      'Authorization': `Bearer ${env.AXIOM_TOKEN}`,
      'X-Axiom-Dataset': env.AXIOM_DATASET
    }
  };
  
  // 显式加上 Organization ID
  if (env.AXIOM_ORG_ID) {
    config.headers['X-Axiom-Org-Id'] = env.AXIOM_ORG_ID;
  }
  
  return config;
}

/**
 * 检查 QStash 配置是否有效
 * @param {Object} env - 环境对象
 * @returns {boolean} - QStash 是否配置
 */
export function isQStashConfigured(env) {
  return !!(env.QSTASH_CURRENT_SIGNING_KEY);
}

/**
 * 检查管理员认证配置是否有效
 * @param {Object} env - 环境对象
 * @returns {boolean} - 管理员认证是否配置
 */
export function isAdminAuthConfigured(env) {
  return !!(env.ADMIN_API_TOKEN);
}

/**
 * 检查缓存提供者是否配置
 * @param {Object} env - 环境对象
 * @returns {boolean} - 是否有缓存提供者
 */
export function isCacheProviderConfigured(env) {
  const providers = getProviderPriority(env);
  return providers.length > 0 || !!env.CACHE_PROVIDERS;
}

/**
 * 获取签名验证过期窗口
 * @param {Object} env - 环境对象
 * @returns {number} - 过期窗口（秒）
 */
export function getSignatureExpirationWindow(env) {
  const window = getNumberEnv(env, ENV_KEYS.SIGNATURE_EXPIRATION_WINDOW, 900);
  return Math.max(1, window); // 至少1秒
}

/**
 * 检查是否跳过管理员认证
 * @param {Object} env - 环境对象
 * @returns {boolean} - 是否跳过
 */
export function shouldSkipAdminAuth(env) {
  return getBooleanEnv(env, ENV_KEYS.SKIP_ADMIN_AUTH, false);
}

/**
 * 检查是否跳过签名验证
 * @param {Object} env - 环境对象
 * @returns {boolean} - 是否跳过
 */
export function shouldSkipSignatureVerify(env) {
  return getBooleanEnv(env, ENV_KEYS.SKIP_SIGNATURE_VERIFY, false);
}

/**
 * 检查是否启用调试日志
 * @param {Object} env - 环境对象
 * @returns {boolean} - 是否启用
 */
export function shouldDebugLogs(env) {
  return getBooleanEnv(env, ENV_KEYS.DEBUG_LOGS, false);
}

/**
 * 获取版本信息
 * @param {Object} env - 环境对象
 * @returns {string} - 版本号
 */
export function getVersion(env) {
  return env.VERSION || 'unknown';
}

/**
 * 获取环境名称
 * @param {Object} env - 环境对象
 * @returns {string} - 环境名称
 */
export function getEnvironmentName(env) {
  return normalizeEnvName(env.NODE_ENV || 'prod');
}