/**
 * 安全序列化工具
 * 用于将任意数据安全地转换为字符串，防止循环引用、超长数据等问题
 */

/**
 * 限制对象字段数量
 * @param {Object} obj - 要限制的对象
 * @param {number} maxFields - 最大字段数
 * @returns {Object} - 限制后的对象
 */
export const limitFields = (obj, maxFields = 200) => {
  if (!obj || typeof obj !== 'object') return obj;
  
  const result = {};
  let count = 0;
  
  for (const key in obj) {
    if (count >= maxFields) {
      result._truncated = true;
      break;
    }
    
    if (obj.hasOwnProperty(key)) {
      result[key] = obj[key];
      count++;
    }
  }
  
  return result;
};

/**
 * 序列化 Error 对象
 * @param {Error} err - 错误对象
 * @returns {Object} - 序列化后的错误
 */
export const serializeError = (err) => {
  if (!(err instanceof Error)) return err;
  const serialized = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  // Add any additional enumerable properties
  for (const key in err) {
    if (err.hasOwnProperty(key) && !(key in serialized)) {
      serialized[key] = err[key];
    }
  }
  return serialized;
};

/**
 * 递归裁剪对象，限制深度和字段数量
 * @param {any} obj - 要裁剪的对象
 * @param {number} maxDepth - 最大深度
 * @param {number} maxKeys - 每个对象的最大键数
 * @param {number} currentDepth - 当前深度
 * @param {WeakSet} seen - 循环引用追踪
 * @returns {any} - 裁剪后的对象
 */
export const pruneData = (obj, maxDepth = 2, maxKeys = 5, currentDepth = 0, seen = new WeakSet()) => {
  if (currentDepth >= maxDepth) {
      if (typeof obj === 'object' && obj !== null) {
          return '[Truncated: Max Depth]';
      }
      return obj;
  }
  
  if (obj === null || typeof obj !== 'object') return obj;
  
  // 循环引用检测
  if (seen.has(obj)) {
      return '[Circular Reference]';
  }
  seen.add(obj);
  
  if (Array.isArray(obj)) {
      // 更严格的数组处理：最多保留 5 项，每项深度递减
      const prunedArray = obj.slice(0, maxKeys).map(item => pruneData(item, maxDepth, maxKeys, currentDepth + 1, seen));
      if (obj.length > maxKeys) {
          prunedArray.push(`[Truncated: ${obj.length - maxKeys} items]`);
      }
      return prunedArray;
  }

  // Error 对象特殊处理
  if (obj instanceof Error) {
      const serialized = serializeError(obj);
      return pruneData(serialized, maxDepth, maxKeys, currentDepth, seen);
  }

  const newObj = {};
  let keyCount = 0;
  
  for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
          if (keyCount >= maxKeys) {
              newObj['_truncated'] = `... ${Object.keys(obj).length - maxKeys} more keys`;
              break;
          }
          newObj[key] = pruneData(obj[key], maxDepth, maxKeys, currentDepth + 1, seen);
          keyCount++;
      }
  }
  return newObj;
};

/**
 * 安全地将任意对象转换为字符串
 * 1. 限制深度
 * 2. 捕获 Error 对象
 * 3. 超长时使用摘要
 * 4. 处理循环引用
 * 5. 处理特殊值（undefined, function, symbol, BigInt）
 * 
 * @param {any} data - 要序列化的数据
 * @param {number} maxDepth - 最大深度，默认 2
 * @param {number} maxLength - 最大长度，默认 5000
 * @returns {string} - 安全的 JSON 字符串
 */
export const serializeToString = (data, maxDepth = 2, maxLength = 5000) => {
  // 处理特殊原始值
  if (data === undefined) return '{"value":"undefined"}';
  if (typeof data === 'function') return '{"value":"[Function]"}';
  if (typeof data === 'symbol') return `{"value":"${String(data)}"}`;
  
  const seen = new WeakSet();
  let pruned;

  try {
    pruned = pruneData(data, maxDepth, 5, 0, seen);
  } catch (e) {
    return JSON.stringify({ 
      error: '[Prune failed]', 
      reason: e.message 
    });
  }

  let str;
  try {
    str = JSON.stringify(pruned, (key, value) => {
      // BigInt 处理
      if (typeof value === 'bigint') {
        return value.toString() + 'n';
      }
      // 双重循环引用保护（额外安全层）
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) {
          return '[Circular]';
        }
      }
      return value;
    });
  } catch (e) {
    return JSON.stringify({
      error: '[Stringify failed]',
      reason: e.message,
      type: typeof data
    });
  }

  // 长度限制
  if (str.length > maxLength) {
    return JSON.stringify({
      summary: 'Data truncated',
      original_size: str.length,
      preview: str.substring(0, 200) + '...',
      service: pruned?.service || 'unknown'
    });
  }

  return str;
};