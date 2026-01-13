/**
 * CF Workers 优化的工厂函数创建模块
 */

// 动态导入以避免循环依赖
let loggerModule = null;

// 工具函数
function normalizeEnvName(env) {
  if (!env) return 'prod';
  
  const envMap = {
    'development': 'dev',
    'dev': 'dev',
    'staging': 'pre',
    'pre': 'pre',
    'production': 'prod',
    'prod': 'prod'
  };
  
  return envMap[env.toLowerCase()] || 'prod';
}

function isDevEnv(env) {
  return ['dev', 'development'].includes(normalizeEnvName(env));
}

// CF Workers 全局配置
const baseLoggerConfig = {
  debugEnabled: typeof globalThis !== 'undefined' && globalThis.DEBUG_LOGS === 'true'
};

// 检查测试环境
const isTestEnvironment = typeof globalThis !== 'undefined' && globalThis.VITEST === 'true';

// 版本信息
const VERSION = typeof globalThis !== 'undefined' && globalThis.VERSION ? globalThis.VERSION : 'dev';

// OpenTelemetry 集成（简化版本）
function addOtelEvent(level, message, data, span) {
  // CF Workers 环境下轻量化处理
  if (span && typeof span.addEvent === 'function') {
    span.addEvent({
      name: `log.${level}`,
      attributes: {
        'log.message': message,
        'log.level': level,
        ...Object.fromEntries(Object.entries(data).map(([k, v]) => [`log.${k}`, String(v)]))
      }
    });
  }
}

/**
 * 创建日志工厂函数
 * 适配 CF Workers 的快速启动需求
 */
export async function createLoggerFactory(context, bindings = {}) {
  // 延迟加载日志模块以避免循环依赖
  if (!loggerModule) {
    loggerModule = await import('./index.js');
  }
  
  const { createLoggerFactory: createOptimizedLoggerFactory } = loggerModule;
  return createOptimizedLoggerFactory(context, bindings);
}

// 导出工具函数
export { normalizeEnvName, isDevEnv, addOtelEvent, VERSION, isTestEnvironment, baseLoggerConfig };