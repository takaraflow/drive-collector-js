import { MAX_JSON_SIZE, LOG_CONFIG } from '../config/constants.js';

/**
 * 检查是否为字符串类型（排除其他类型）
 * @param {any} value - 要检查的值
 * @returns {boolean} - 是否为字符串类型
 */
export function isString(value) {
  return typeof value === 'string' || value instanceof String;
}

/**
 * 获取对象深度
 * @param {Object} obj - 要检查的对象
 * @param {number} currentDepth - 当前深度（默认为0）
 * @returns {number} - 对象深度
 */
export function getObjectDepth(obj, currentDepth = 0) {
  if (currentDepth > LOG_CONFIG.MAX_DEPTH) return currentDepth; // 防止无限递归
  
  if (obj === null || typeof obj !== 'object') {
    return currentDepth;
  }
  
  if (Array.isArray(obj)) {
    return obj.length === 0 ? currentDepth : 
           Math.max(...obj.map(item => getObjectDepth(item, currentDepth + 1)));
  }
  
  const keys = Object.keys(obj);
  return keys.length === 0 ? currentDepth :
         Math.max(...keys.map(key => getObjectDepth(obj[key], currentDepth + 1)));
}

/**
 * 稳健的 JSON 解析函数，支持自动修复无引号键
 * @param {string|Uint8Array|ArrayBuffer|Object} data - 要解析的数据
 * @param {string} context - 解析上下文（用于错误日志）
 * @returns {Object|null} - 解析后的对象或null
 */
export function safeJsonParse(data, context = '') {
  // 检查数据大小
  if (data && typeof data === 'string' && data.length > MAX_JSON_SIZE) {
    throw new Error(`JSON 数据过大: ${data.length} bytes (最大 ${MAX_JSON_SIZE} bytes)`);
  }
  
  if (data === null || data === undefined) return null;
  
  // 优先处理二进制数据
  if (data instanceof Uint8Array) {
    data = new TextDecoder().decode(data);
  } else if (ArrayBuffer.isView(data)) {
    data = new TextDecoder().decode(data.buffer);
  } else if (data instanceof ArrayBuffer) {
    data = new TextDecoder().decode(new Uint8Array(data));
  }
  
  // 检查是否已经是解析好的对象（但不处理字符串）
  if (typeof data === 'object' && !isString(data)) return data;

  try {
    return JSON.parse(data);
  } catch (e) {
    try {
      let fixedData = data.trim();
      if (fixedData.startsWith('{') && fixedData.endsWith('}')) {
        fixedData = fixedData.slice(1, -1);
      }
      fixedData = fixedData.replace(/(^|[{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
      fixedData = `{${fixedData}}`;
      return JSON.parse(fixedData);
    } catch (fixError) {
      return null;
    }
  }
}

/**
 * 增强的 JSON 解析函数，支持更多选项和验证
 * @param {string} data - 要解析的字符串数据
 * @param {string} context - 解析上下文（用于错误日志）
 * @param {Object} options - 配置选项
 * @param {boolean} options.returnNullOnFailure - 失败时返回null（默认true）
 * @param {boolean} options.logErrors - 是否记录错误（默认true）
 * @param {number} options.maxDepth - 最大嵌套深度（默认10）
 * @param {number} options.maxStringLength - 最大字符串长度（默认100000）
 * @returns {any} - 解析后的数据
 */
export function enhancedSafeJsonParse(data, context = 'unknown', options = {}) {
  const {
    returnNullOnFailure = true,
    logErrors = true,
    maxDepth = LOG_CONFIG.MAX_DEPTH,
    maxStringLength = LOG_CONFIG.MAX_STRING_LENGTH
  } = options;

  // 输入验证
  if (data === null || data === undefined) {
    if (logErrors) {
      console.warn(`⚠️ [JSON Parse] ${context}: 输入为空`);
    }
    return null;
  }

  if (typeof data !== 'string') {
    if (logErrors) {
      console.warn(`⚠️ [JSON Parse] ${context}: 输入不是字符串类型`, { 
        type: typeof data, 
        value: String(data).substring(0, 100) 
      });
    }
    return returnNullOnFailure ? null : data;
  }

  // 字符串长度检查
  if (data.length > maxStringLength) {
    if (logErrors) {
      console.error(`❌ [JSON Parse] ${context}: 字符串过长 (${data.length} > ${maxStringLength})`);
    }
    return returnNullOnFailure ? null : { error: 'String too long' };
  }

  try {
    const parsed = JSON.parse(data);
    
    // 深度检查
    const depth = getObjectDepth(parsed);
    if (depth > maxDepth) {
      if (logErrors) {
        console.warn(`⚠️ [JSON Parse] ${context}: 对象嵌套过深 (${depth} > ${maxDepth})`);
      }
      return returnNullOnFailure ? null : { error: 'Object too deep' };
    }

    return parsed;
  } catch (error) {
    if (logErrors) {
      console.error(`❌ [JSON Parse] ${context}: 解析失败`, {
        error: error.message,
        dataLength: data.length,
        dataPreview: data.substring(0, 200)
      });
    }
    
    return returnNullOnFailure ? null : { 
      error: `JSON parse failed: ${error.message}`,
      originalData: data.length > 1000 ? data.substring(0, 1000) + '...' : data
    };
  }
}

/**
 * 缓存键名转换函数
 * @param {any} value - 要转换的值
 * @returns {string} - 转换后的字符串
 */
export function coerceCacheKeyName(value) {
  if (value instanceof Uint8Array) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value.buffer);
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  return String(value);
}