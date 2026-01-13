/**
 * 管理员认证模块
 * 验证管理员API Token
 */

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

  if (providedToken !== token) {
    throw new Error('无效的 API Token');
  }

  if (log.debug) await log.debug('✅ 管理员Token验证成功', {});
  return true;
}

export { verifyAdminToken };