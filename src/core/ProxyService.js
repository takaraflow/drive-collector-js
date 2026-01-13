/**
 * 代理服务模块
 * 处理请求转发和重试逻辑
 */

import { logger } from '../logger.js';

/**
 * 获取日志器（兼容处理）
 * @param {Object} requestLogger - 请求日志器
 * @param {string} moduleName - 模块名
 * @param {Object} ctx - Cloudflare Workers上下文
 * @returns {Object} 日志器
 */
function resolveLogger({ requestLogger = null, moduleName = 'unknown', ctx = null } = {}) {
  if (requestLogger) return requestLogger;
  const bindings = { module: moduleName };
  if (ctx?.logBuffer && bindings.logBuffer === undefined) {
    bindings.logBuffer = ctx.logBuffer;
  }
  const childLogger = typeof logger.child === 'function' ? logger.child(bindings) : undefined;
  return childLogger || logger;
}

/**
 * 转发请求到目标实例
 * @param {Object} instance - 目标实例
 * @param {URL} normalizedUrl - 规范化后的URL
 * @param {Request} request - 原始请求
 * @param {any} originalBody - 原始请求体
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} requestLogger - 请求日志器
 * @returns {Promise<Response>} 响应
 */
async function forwardToInstance(instance, normalizedUrl, request, originalBody, ctx = null, requestLogger = null) {
  const forwardToInstanceLogger = resolveLogger({ requestLogger, moduleName: 'forwardToInstance', ctx });
  const url = new URL(normalizedUrl.href);
  url.host = new URL(instance.url).host;
  url.protocol = new URL(instance.url).protocol;

  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.delete('host');

  headers.set('Host', url.host);

  const requestOptions = {
    method: request.method,
    headers: {
      ...Object.fromEntries(headers),
      'X-Forwarded-Host': request.headers.get('Host'),
      'X-Forwarded-Proto': url.protocol.replace(':', ''),
      'X-Forwarded-For': request.headers.get('CF-Connecting-IP') || '',
      'X-Load-Balancer': 'qstash-lb'
    },
    redirect: 'follow'
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    requestOptions.body = originalBody;
  } else {
    // 对于 GET 请求，确保 body 为 undefined 而不是 null
    requestOptions.body = undefined;
  }

  const forwardRequest = new Request(url.toString(), requestOptions);
  await forwardToInstanceLogger.info('转发请求到实例', { 
    instanceId: instance.id, 
    targetUrl: url.toString(),
    originalPath: normalizedUrl.pathname
  });
  const response = await fetch(forwardRequest);

  if (response.status >= 500) {
    await forwardToInstanceLogger.warn('后端返回 5xx 错误', { status: response.status, instanceId: instance.id });
  } else if (response.status >= 400 && response.status < 500) {
    await forwardToInstanceLogger.warn('后端返回 4xx 错误', { 
      status: response.status, 
      statusText: response.statusText, 
      instanceId: instance.id, 
      targetUrl: url.toString() 
    });
  }

  return response;
}

/**
 * 带重试的转发逻辑
 * @param {Array} instances - 实例数组
 * @param {URL} normalizedUrl - 规范化后的URL
 * @param {Request} request - 原始请求
 * @param {Object} env - 环境变量
 * @param {any} body - 请求体
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} requestLogger - 请求日志器
 * @returns {Promise<Response>} 响应
 */
async function fetchWithRetry(instances, normalizedUrl, request, env, body, ctx, requestLogger = null) {
  const fetchWithRetryLogger = resolveLogger({ requestLogger, moduleName: 'fetchWithRetry', ctx });
  let lastError;
  let last5xxResponse = null;

  for (const instance of instances) {
    try {
      const response = await forwardToInstance(instance, normalizedUrl, request, body, ctx, requestLogger);
      
      // 4xx 错误：直接透传，不再重试其他实例
      if (response.status >= 400 && response.status < 500) {
        await fetchWithRetryLogger.warn('实例返回 4xx 错误，停止重试', { status: response.status, instanceId: instance.id });
        if (last5xxResponse && last5xxResponse.body) {
          await last5xxResponse.body.cancel().catch(() => {});
        }
        return response;
      }
      
      // 5xx 错误：保存并继续尝试其他实例
      if (response.status >= 500) {
        if (last5xxResponse && last5xxResponse.body) {
          await last5xxResponse.body.cancel().catch(() => {});
        }
        last5xxResponse = response;
        continue;
      }
      
      // 2xx, 3xx 响应：成功，取消之前保存的 5xx 响应
      if (last5xxResponse && last5xxResponse.body) {
        await last5xxResponse.body.cancel().catch(() => {});
      }
      return response;
    } catch (error) {
      await fetchWithRetryLogger.error('转发请求失败', { instanceId: instance.id, error: error.message });
      lastError = error;
      // 新增：在每次请求失败时，也尝试取消之前保存的 5xx 响应体，防止泄漏
      if (last5xxResponse && last5xxResponse.body) {
        await last5xxResponse.body.cancel().catch(() => {});
      }
    }
  }

  // 如果有 5xx 响应，返回最后一个 5xx 响应（new-features 测试期望）
  if (last5xxResponse) {
    await fetchWithRetryLogger.warn('所有实例均返回 5xx', { status: last5xxResponse.status });
    // 注意：这里不取消 last5xxResponse.body，因为需要返回给调用者
    // 调用者负责在使用完响应后调用 cancel()
    return last5xxResponse;
  }

  // 如果没有 5xx 响应但有错误，抛出错误
  if (lastError) {
    throw lastError;
  }

  // 如果既没有 5xx 响应也没有错误，说明所有实例都失败了
  throw new Error('All instances failed');
}

export {
  forwardToInstance,
  fetchWithRetry
};