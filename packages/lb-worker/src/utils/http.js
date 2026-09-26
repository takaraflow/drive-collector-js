import { MAX_REQUEST_BODY_SIZE, ERROR_MESSAGES, HTTP_STATUS } from '../config/constants.js';

/**
 * 创建负载过大错误
 * @param {number} size - 实际大小
 * @param {number} limit - 限制大小
 * @returns {Error} - 错误对象
 */
export function createPayloadTooLargeError(size, limit = MAX_REQUEST_BODY_SIZE) {
  const error = new Error(`${ERROR_MESSAGES.PAYLOAD_TOO_LARGE}: ${size} bytes (limit ${limit} bytes)`);
  error.status = HTTP_STATUS.PAYLOAD_TOO_LARGE;
  error.code = 'PAYLOAD_TOO_LARGE';
  return error;
}

/**
 * 验证 Content-Length 头
 * @param {Request} request - 请求对象
 * @param {number} maxSize - 最大允许大小
 * @returns {number|null} - 内容长度或null
 * @throws {Error} - 当内容过大时抛出错误
 */
export function validateContentLengthHeader(request, maxSize = MAX_REQUEST_BODY_SIZE) {
  if (!request?.headers?.get) return null;
  
  const rawLength = request.headers.get('content-length');
  if (rawLength === null || rawLength === undefined) return null;

  const length = Number(rawLength);
  if (!Number.isFinite(length) || length < 0) return null;

  if (length > maxSize) {
    throw createPayloadTooLargeError(length, maxSize);
  }

  return length;
}

/**
 * 带大小限制的请求体读取
 * @param {Request} request - 请求对象
 * @param {number} maxSize - 最大允许大小
 * @returns {Promise<{bodyData: Uint8Array, bodyString: string}>} - 请求体数据
 * @throws {Error} - 当内容过大或读取失败时抛出错误
 */
export async function readRequestBodyWithLimit(request, maxSize = MAX_REQUEST_BODY_SIZE) {
  // 使用流式读取（适用于可读流）
  if (request.body && typeof request.body.getReader === 'function') {
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunkSize = value?.byteLength ?? value?.length ?? 0;
      total += chunkSize;
      if (total > maxSize) {
        throw createPayloadTooLargeError(total, maxSize);
      }
      chunks.push(value);
    }

    const bodyData = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      bodyData.set(view, offset);
      offset += view.byteLength;
    }

    return {
      bodyData,
      bodyString: new TextDecoder().decode(bodyData)
    };
  }

  // 使用 text() 方法（适用于标准 Request）
  if (typeof request.text === 'function') {
    const bodyString = await request.text();
    const bodyData = new TextEncoder().encode(bodyString);

    if (bodyData.byteLength > maxSize) {
      throw createPayloadTooLargeError(bodyData.byteLength, maxSize);
    }

    return { bodyData, bodyString };
  }

  // 使用 arrayBuffer() 方法（备用方案）
  if (typeof request.arrayBuffer === 'function') {
    const buffer = await request.arrayBuffer();
    const bodyData = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

    if (bodyData.byteLength > maxSize) {
      throw createPayloadTooLargeError(bodyData.byteLength, maxSize);
    }

    return {
      bodyData,
      bodyString: new TextDecoder().decode(bodyData)
    };
  }

  throw new Error(ERROR_MESSAGES.REQUEST_BODY_READ_ERROR);
}

/**
 * 创建标准化的 HTTP 响应
 * @param {Object} data - 响应数据
 * @param {number} status - HTTP 状态码
 * @param {string} contentType - 内容类型
 * @returns {Response} - 标准化响应
 */
export function createResponse(data, status = HTTP_STATUS.OK, contentType = 'application/json') {
  const body = contentType === 'application/json' ? JSON.stringify(data) : data;
  
  return new Response(body, {
    status,
    headers: {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    }
  });
}

/**
 * 创建错误响应
 * @param {string} message - 错误消息
 * @param {number} status - HTTP 状态码
 * @param {Object} additionalData - 附加数据
 * @returns {Response} - 错误响应
 */
export function createErrorResponse(message, status = HTTP_STATUS.INTERNAL_SERVER_ERROR, additionalData = {}) {
  const errorData = {
    error: message,
    timestamp: new Date().toISOString(),
    ...additionalData
  };
  
  return createResponse(errorData, status);
}

/**
 * 创建预检响应（CORS）
 * @returns {Response} - 预检响应
 */
export function createPreflightResponse() {
  return new Response(null, {
    status: HTTP_STATUS.NO_CONTENT,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*'
    }
  });
}

/**
 * 解析请求 URL 并规范化
 * @param {string} urlString - 原始 URL
 * @returns {URL} - 规范化后的 URL 对象
 */
export function parseAndNormalizeUrl(urlString) {
  const url = new URL(urlString);
  url.pathname = url.pathname.replace(/\/+/g, '/');
  return url;
}

/**
 * 提取请求源信息
 * @param {Request} request - 请求对象
 * @returns {Object} - 请求源信息
 */
export function extractRequestSourceInfo(request) {
  const clientIP = request.headers.get('cf-connecting-ip') || 'unknown';
  const userAgent = request.headers.get('user-agent') || 'unknown';
  const referer = request.headers.get('referer') || 'none';
  const cfRay = request.headers.get('cf-ray') || 'unknown';
  const country = request.headers.get('cf-ipcountry') || 'unknown';

  return {
    clientIP: clientIP.length > 50 ? clientIP.substring(0, 50) + '...' : clientIP,
    userAgent: userAgent.length > 200 ? userAgent.substring(0, 200) + '...' : userAgent,
    referer,
    cfRay,
    country
  };
}

/**
 * 创建请求头对象（排除敏感信息）
 * @param {Headers} headers - 原始请求头
 * @param {Array<string>} excludeKeys - 要排除的键名
 * @returns {Object} - 过滤后的请求头对象
 */
export function createSafeHeadersObject(headers, excludeKeys = ['authorization', 'cookie', 'x-api-token']) {
  const safeHeaders = {};
  
  if (!headers || typeof headers.entries !== 'function') {
    return safeHeaders;
  }

  for (const [key, value] of headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (!excludeKeys.some(exclude => lowerKey.includes(exclude.toLowerCase()))) {
      safeHeaders[key] = value;
    }
  }

  return safeHeaders;
}

/**
 * 检查请求是否为 GET 或 HEAD 方法
 * @param {Request} request - 请求对象
 * @returns {boolean} - 是否为 GET 或 HEAD
 */
export function isGetOrHeadRequest(request) {
  const method = request.method.toUpperCase();
  return method === 'GET' || method === 'HEAD';
}

/**
 * 创建转发请求的选项对象
 * @param {Request} request - 原始请求
 * @param {URL} targetUrl - 目标 URL
 * @param {Uint8Array|ArrayBuffer} body - 请求体
 * @returns {RequestInit} - 请求选项
 */
export function createForwardRequestOptions(request, targetUrl, body = null) {
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.delete('host');

  headers.set('Host', targetUrl.host);
  headers.set('X-Forwarded-Host', request.headers.get('Host'));
  headers.set('X-Forwarded-Proto', targetUrl.protocol.replace(':', ''));
  headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') || '');
  headers.set('X-Load-Balancer', 'qstash-lb');

  const options = {
    method: request.method,
    headers: Object.fromEntries(headers),
    redirect: 'follow'
  };

  if (request.method !== 'GET' && request.method !== 'HEAD' && body !== null) {
    options.body = body;
  } else {
    options.body = undefined;
  }

  return options;
}

/**
 * 验证响应状态码
 * @param {Response} response - 响应对象
 * @returns {boolean} - 是否为成功响应
 */
export function isSuccessResponse(response) {
  return response.status >= 200 && response.status < 300;
}

/**
 * 验证响应是否为客户端错误（4xx）
 * @param {Response} response - 响应对象
 * @returns {boolean} - 是否为客户端错误
 */
export function isClientErrorResponse(response) {
  return response.status >= 400 && response.status < 500;
}

/**
 * 验证响应是否为服务器错误（5xx）
 * @param {Response} response - 响应对象
 * @returns {boolean} - 是否为服务器错误
 */
export function isServerErrorResponse(response) {
  return response.status >= 500;
}

/**
 * 创建请求超时错误
 * @param {string} operation - 操作名称
 * @param {number} timeoutMs - 超时时间（毫秒）
 * @returns {Error} - 超时错误
 */
export function createTimeoutError(operation, timeoutMs) {
  return new Error(`${operation} timed out after ${timeoutMs}ms`);
}

/**
 * 安全地取消响应体
 * @param {Response} response - 响应对象
 * @returns {Promise<void>}
 */
export async function safeCancelResponseBody(response) {
  if (response && response.body && typeof response.body.cancel === 'function') {
    try {
      await response.body.cancel();
    } catch (e) {
      // 忽略取消错误
    }
  }
}