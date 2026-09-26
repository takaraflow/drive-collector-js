/**
 * 实例解析模块
 * 处理实例数据的规范化和解析
 */

import { safeJsonParse } from '../utils/json.js';

/**
 * 规范化时间戳为毫秒
 * @param {number|string} timestamp - 时间戳
 * @returns {number|null} 规范化后的毫秒时间戳
 */
function normalizeEpochMillis(timestamp) {
  if (!timestamp) return null;
  
  // 如果已经是毫秒级时间戳（13位数字）
  if (typeof timestamp === 'number' && timestamp > 1000000000000) {
    return timestamp;
  }
  
  // 如果是秒级时间戳（10位数字）
  if (typeof timestamp === 'number' && timestamp > 1000000000 && timestamp < 10000000000) {
    return timestamp * 1000;
  }
  
  // 如果是字符串
  if (typeof timestamp === 'string') {
    const num = parseInt(timestamp, 10);
    if (!isNaN(num)) {
      return normalizeEpochMillis(num);
    }
    
    // 尝试解析ISO字符串
    const parsed = Date.parse(timestamp);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  
  return null;
}

/**
 * 规范化心跳时间
 * @param {number|string} heartbeat - 心跳时间
 * @returns {number} 规范化后的心跳时间戳
 */
function normalizeHeartbeat(heartbeat) {
  const normalized = normalizeEpochMillis(heartbeat);
  return normalized || Date.now();
}

/**
 * 解析实例数据
 * @param {any} data - 实例数据
 * @returns {Object|null} 解析后的实例对象
 */
function parseInstanceData(data) {
  if (!data) return null;
  
  try {
    // 首先使用原有的safeJsonParse来保持兼容性
    let parsed = safeJsonParse(data, 'instance');
    
    // 如果输入已经是对象（但不是字符串类型），直接使用
    if (typeof data === 'object' && data !== null && typeof data !== 'string') {
      parsed = data;
    }
    
    if (!parsed) {
      console.warn('⚠️ [Instance Data] 解析失败', {
        dataType: typeof data,
        isArrayBuffer: ArrayBuffer.isView(data),
        isUint8Array: data instanceof Uint8Array,
        dataPreview: typeof data === 'string' ? data.substring(0, 100) : 'non-string'
      });
      return null;
    }
    
    // 处理嵌套的value字段
    if (parsed && typeof parsed === 'object' && parsed.value !== undefined) {
      const inner = safeJsonParse(parsed.value, 'instance.value');
      if (inner) {
        parsed = inner;
      }
    }

    const lastHeartbeat = normalizeHeartbeat(parsed.lastHeartbeat ?? parsed.startedAt);
    const startedAt = normalizeHeartbeat(parsed.startedAt);
    
    return {
      id: parsed.id || 'unknown',
      url: parsed.url || '',
      hostname: parsed.hostname,
      status: parsed.status || 'active',
      lastHeartbeat: lastHeartbeat ?? Date.now(),
      startedAt,
      region: parsed.region || 'unknown'
    };
  } catch (e) {
    console.error('❌ [Instance Data] 解析异常', {
      error: e.message,
      dataType: typeof data,
      stack: e.stack
    });
    return null;
  }
}

export {
  normalizeEpochMillis,
  normalizeHeartbeat,
  parseInstanceData
};