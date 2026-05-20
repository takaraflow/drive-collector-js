/**
 * 安全序列化工具
 * 用于将任意数据安全地转换为字符串，防止循环引用、超长数据等问题
 */

export const REDACTED_VALUE = '[REDACTED]';

const SENSITIVE_KEY_PATTERN = /(token|password|passwd|pwd|pass|secret|key|auth|authorization|cookie|configdata|credential|private|license|session)/i;
const SENSITIVE_TEXT_KEYS = [
  'access_token',
  'refresh_token',
  'client_secret',
  'client_id',
  'token',
  'pass',
  'password',
  'passwd',
  'pwd',
  'secret',
  'secret_access_key',
  'access_key_id',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'session',
  'user'
];
const SENSITIVE_TEXT_KEY_PATTERN = SENSITIVE_TEXT_KEYS.join('|');
const RCLONE_SECRET_PARAM_PATTERN = 'user|pass|password|token|access_token|refresh_token|client_secret|client_id|secret|key|api_key|apikey';

const redactSensitiveAssignments = (text, keyPattern) => {
  const pattern = new RegExp(`\\b(?:${keyPattern})\\b\\s*=\\s*`, 'gi');
  let output = '';
  let index = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const valueStart = pattern.lastIndex;
    output += text.slice(index, valueStart);

    let cursor = valueStart;
    let slashCount = 0;
    while (text[cursor] === '\\') {
      slashCount++;
      cursor++;
    }

    if (text[cursor] !== '"') {
      let valueEnd = cursor;
      if (text.slice(cursor, cursor + REDACTED_VALUE.length) === REDACTED_VALUE) {
        valueEnd = cursor + REDACTED_VALUE.length;
      } else if (text[valueEnd] === '{') {
        let depth = 0;
        while (valueEnd < text.length) {
          if (text[valueEnd] === '{') depth++;
          if (text[valueEnd] === '}') {
            depth--;
            valueEnd++;
            if (depth <= 0) break;
            continue;
          }
          valueEnd++;
        }
      }
      while (valueEnd < text.length && !/[\s,;&'{}\[\]:]/.test(text[valueEnd])) {
        valueEnd++;
      }
      output += REDACTED_VALUE;
      index = valueEnd;
      pattern.lastIndex = valueEnd;
      continue;
    }

    const quoteToken = `${'\\'.repeat(slashCount)}"`;
    cursor++;
    let endQuote = -1;
    for (let i = cursor; i < text.length; i++) {
      if (text[i] !== '"') continue;
      let precedingSlashes = 0;
      for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) {
        precedingSlashes++;
      }
      if (precedingSlashes === slashCount) {
        endQuote = i;
        break;
      }
    }

    output += `${quoteToken}${REDACTED_VALUE}${quoteToken}`;
    index = endQuote === -1 ? cursor : endQuote + 1;
    pattern.lastIndex = index;
  }

  return output + text.slice(index);
};

export const isSensitiveKey = (key) => {
  if (key === undefined || key === null) return false;
  const normalizedKey = String(key).replace(/[_\-.]/g, '');
  return SENSITIVE_KEY_PATTERN.test(normalizedKey);
};

export const redactValueForKey = (key, value) => {
  if (value === undefined || value === null) return value;
  if (isSensitiveKey(key)) return REDACTED_VALUE;
  return typeof value === 'string' ? redactSensitiveText(value) : value;
};

export const redactSensitiveText = (value) => {
  if (value === undefined || value === null) return value;

  let text = String(value);
  if (!text) return text;

  text = text.replace(
    new RegExp(`(\\\\?"(?:${SENSITIVE_TEXT_KEY_PATTERN})\\\\?"\\s*:\\s*\\\\*")((?:\\\\.|[^"\\\\])*)(\\\\*")`, 'gi'),
    `$1${REDACTED_VALUE}$3`
  );
  text = redactSensitiveAssignments(text, SENSITIVE_TEXT_KEY_PATTERN);
  text = redactSensitiveAssignments(text, RCLONE_SECRET_PARAM_PATTERN);
  text = text.replace(
    new RegExp(`(\\b(?:access_token|refresh_token|client_secret|token|password|passwd|pwd|secret|secret_access_key|api_key|apikey)\\b\\s*=\\s*)\\{[^\\r\\n}]*\\}`, 'gi'),
    `$1${REDACTED_VALUE}`
  );
  text = text.replace(
    /(\bAuthorization\b\s*[:=]\s*(?:Bearer|Basic)\s+)([A-Za-z0-9._~+/=-]+)/gi,
    `$1${REDACTED_VALUE}`
  );
  text = text.replace(
    new RegExp(`(\\b(?:access_token|refresh_token|client_secret|token|pass|password|passwd|pwd|secret|secret_access_key|access_key_id|api_key|apikey|cookie|session)\\b\\s*[:=]\\s*)([^\\s,;&"'{}\\[\\]]+)`, 'gi'),
    (match, prefix, rawValue) => rawValue === '\\' ? match : `${prefix}${REDACTED_VALUE}`
  );
  text = text.replace(
    /([?&](?:access_token|refresh_token|token|key|secret|password|pass|api_key|apikey)=)([^&#\s]+)/gi,
    `$1${REDACTED_VALUE}`
  );
  text = text.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    `$1${REDACTED_VALUE}:${REDACTED_VALUE}@`
  );

  return text;
};

const truncateString = (value, maxLength = 2000) => {
  const text = redactSensitiveText(value);
  return text.length > maxLength ? `${text.substring(0, maxLength)}...` : text;
};

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
    message: redactSensitiveText(err.message),
    stack: redactSensitiveText(err.stack),
  };
  // Add any additional enumerable properties
  for (const key in err) {
    if (err.hasOwnProperty(key) && !(key in serialized)) {
      serialized[key] = redactValueForKey(key, err[key]);
    }
  }
  return serialized;
};

export const redactSensitiveData = (value, currentKey = '', seen = new WeakMap()) => {
  if (isSensitiveKey(currentKey)) {
    return value === undefined || value === null ? value : REDACTED_VALUE;
  }

  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactSensitiveText(value);
  if (typeof value !== 'object') return value;

  if (value instanceof Error) {
    return serializeError(value);
  }

  if (seen.has(value)) {
    return '[Circular Reference]';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  seen.set(value, true);

  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveData(item, currentKey, seen));
  }

  const redacted = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    redacted[key] = redactSensitiveData(nestedValue, key, seen);
  }
  return redacted;
};

/**
 * Serialize any thrown/rejected value into a telemetry-friendly error shape.
 * Promise rejections are not guaranteed to be Error instances; they can be
 * strings, undefined, plain objects, or library-specific objects.
 *
 * @param {any} value - Unknown error/rejection value.
 * @returns {Object} - Safe, structured error-like object.
 */
export const serializeErrorLike = (value) => {
  if (value instanceof Error) {
    return {
      ...serializeError(value),
      type: 'error',
      constructorName: value.constructor?.name || value.name || 'Error'
    };
  }

  if (value === undefined) {
    return {
      name: 'UndefinedRejection',
      message: 'Promise rejected without a reason',
      type: 'undefined'
    };
  }

  if (value === null) {
    return {
      name: 'NullRejection',
      message: 'Promise rejected with null',
      type: 'null'
    };
  }

  const valueType = typeof value;
  if (valueType !== 'object') {
    return {
      name: `${valueType[0].toUpperCase()}${valueType.slice(1)}Rejection`,
      message: truncateString(value),
      type: valueType,
      value: truncateString(value)
    };
  }

  const constructorName = value.constructor?.name || 'Object';
  const serialized = {
    name: typeof value.name === 'string' && value.name ? value.name : constructorName,
    message: typeof value.message === 'string' && value.message
      ? truncateString(value.message)
      : `Promise rejected with ${constructorName}`,
    type: 'object',
    constructorName
  };

  if (typeof value.stack === 'string' && value.stack) {
    serialized.stack = truncateString(value.stack, 4000);
  }

  for (const key of ['code', 'status', 'statusCode', 'errno', 'syscall']) {
    if (value[key] !== undefined && value[key] !== null) {
      serialized[key] = redactValueForKey(key, value[key]);
    }
  }

  const properties = pruneData(value, 2, 8);
  if (properties && typeof properties === 'object' && Object.keys(properties).length > 0) {
    serialized.properties = properties;
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
export const pruneData = (obj, maxDepth = 2, maxKeys = 5, currentDepth = 0, seen = new WeakSet(), currentKey = '') => {
  if (isSensitiveKey(currentKey)) {
      return obj === undefined || obj === null ? obj : REDACTED_VALUE;
  }

  if (currentDepth >= maxDepth) {
      if (typeof obj === 'object' && obj !== null) {
          return '[Truncated: Max Depth]';
      }
      return typeof obj === 'string' ? redactSensitiveText(obj) : obj;
  }
  
  if (obj === null || typeof obj !== 'object') {
      return typeof obj === 'string' ? redactSensitiveText(obj) : obj;
  }
  
  // 循环引用检测
  if (seen.has(obj)) {
      return '[Circular Reference]';
  }
  seen.add(obj);
  
  if (Array.isArray(obj)) {
      // 更严格的数组处理：最多保留 5 项，每项深度递减
      const prunedArray = obj.slice(0, maxKeys).map(item => pruneData(item, maxDepth, maxKeys, currentDepth + 1, seen, currentKey));
      if (obj.length > maxKeys) {
          prunedArray.push(`[Truncated: ${obj.length - maxKeys} items]`);
      }
      return prunedArray;
  }

  // Error 对象特殊处理
  if (obj instanceof Error) {
      const serialized = serializeError(obj);
      return pruneData(serialized, maxDepth, maxKeys, currentDepth, seen, currentKey);
  }

  const newObj = {};
  let keyCount = 0;
  
  for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
          if (keyCount >= maxKeys) {
              newObj['_truncated'] = `... ${Object.keys(obj).length - maxKeys} more keys`;
              break;
          }
          newObj[key] = pruneData(obj[key], maxDepth, maxKeys, currentDepth + 1, seen, key);
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
      reason: redactSensitiveText(e.message)
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
      reason: redactSensitiveText(e.message),
      type: typeof data
    });
  }

  // 长度限制
  if (str.length > maxLength) {
    return JSON.stringify({
      summary: 'Data truncated',
      original_size: str.length,
      preview: redactSensitiveText(str.substring(0, 200)) + '...',
      service: pruned?.service || 'unknown'
    });
  }

  return str;
};
