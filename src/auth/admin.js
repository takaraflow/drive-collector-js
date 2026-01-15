/**
 * 管理员认证模块
 * 验证管理员API Token
 */

/**
 * timingSafeEqual compares two strings in constant time.
 * Compatible with both Cloudflare Workers and Node.js environments.
 *
 * @param {string} a The first string.
 * @param {string} b The second string.
 * @returns {Promise<boolean>} True if the strings are equal, false otherwise.
 */
async function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const encoder = new TextEncoder();
  const aEncoded = encoder.encode(a);
  const bEncoded = encoder.encode(b);

  if (aEncoded.byteLength !== bEncoded.byteLength) {
    return false;
  }

  try {
    // Cloudflare Workers environment
    if (crypto.subtle && crypto.subtle.timingSafeEqual) {
      return await crypto.subtle.timingSafeEqual(aEncoded, bEncoded);
    }
  } catch (error) {
    // Fall through to alternative implementations
  }

  try {
    // Node.js environment (test environment)
    if (globalThis.crypto && globalThis.crypto.subtle && globalThis.crypto.subtle.timingSafeEqual) {
      return await globalThis.crypto.subtle.timingSafeEqual(aEncoded, bEncoded);
    }
  } catch (error) {
    // Fall through to manual implementation
  }

  // Fallback: manual XOR-based constant-time comparison
  // This is a simplified version that works in all environments
  let result = 0;
  for (let i = 0; i < aEncoded.byteLength; i++) {
    result |= aEncoded[i] ^ bEncoded[i];
  }
  return result === 0;
}


/**
 * 验证管理员API Token
 * @param {Request} request - HTTP请求对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} requestLogger - 请求日志器
 * @returns {Promise<boolean>} 验证是否成功
 * @throws {Error} 当Token验证失败时抛出错误
 */
async function verifyAdminToken(request, env, ctx = null, requestLogger = null) {
  // CF Worker 生命周期管理：确保日志能被正确缓冲和发送
  const log = requestLogger || console;
  
  // 跳过验证（开发环境）
  if (env.SKIP_ADMIN_AUTH === 'true') {
    if (log.debug) await log.debug('⏭️ 跳过管理员鉴权 (Skipping admin auth)', {});
    return true;
  }

  const token = env.ADMIN_API_TOKEN;
  if (!token) {
    throw new Error('ADMIN_API_TOKEN 未配置');
  }

  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    throw new Error('缺少 Authorization 头');
  }

  // 支持 Bearer token 和直接 token
  let providedToken;
  if (authHeader.startsWith('Bearer ')) {
    providedToken = authHeader.slice(7);
  } else {
    providedToken = authHeader;
  }

  const isMatch = await timingSafeEqual(providedToken, token);
  if (!isMatch) {
    throw new Error('无效的 API Token');
  }

  if (log.debug) await log.debug('✅ 管理员Token验证成功', {});
  return true;
}

export { verifyAdminToken };