/**
 * QStash 认证模块
 * 验证 QStash 消息签名
 */

import { Receiver } from '@upstash/qstash';

/**
 * 验证 QStash 签名
 * @param {Request} request - HTTP请求对象
 * @param {Object} env - 环境变量
 * @param {Object} ctx - Cloudflare Workers上下文
 * @param {Object} requestLogger - 请求日志器
 * @returns {Promise<Uint8Array|boolean>} 验证成功返回body数据或true
 * @throws {Error} 当签名验证失败时抛出错误
 */
async function verifyQStashSignature(request, env, ctx = null, requestLogger = null) {
  const log = requestLogger || console;
  
  // 跳过验证（开发环境）- 支持两种环境变量名称
  const skipAuth = env.SKIP_QSTASH_AUTH === 'true' || env.SKIP_SIGNATURE_VERIFY === 'true';
  if (skipAuth) {
    if (log.debug) await log.debug('⏭️ 跳过 QStash 签名验证 (Skipping QStash auth)', {});
    return true;
  }

  // 使用 QSTASH_CURRENT_SIGNING_KEY 保持与原代码兼容
  const currentSigningKey = env.QSTASH_CURRENT_SIGNING_KEY;
  if (!currentSigningKey) {
    throw new Error('QSTASH_CURRENT_SIGNING_KEY 未设置');
  }

  try {
    const receiver = new Receiver({
      currentSigningKey: currentSigningKey,
      nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY || currentSigningKey,
    });

    const signature = request.headers.get('Upstash-Signature');
    if (!signature) {
      throw new Error('缺少 Upstash-Signature 头');
    }

    // 修复：直接读取请求体而不是克隆，防止内存膨胀
    // 注意：这将消耗 request 流，因此必须返回 body 给后续流程使用
    const body = await request.text();
    
    // 验证签名
    const isValid = await receiver.verify({
      signature,
      body: body || '',
      url: request.url,
    });

    if (!isValid) {
      throw new Error('QStash 签名验证失败');
    }

    if (log.debug) await log.debug('✅ QStash 签名验证成功', {});
    
    // 根据请求方法决定返回值
    const isGetRequest = request.method === 'GET' || request.method === 'HEAD';
    if (isGetRequest) {
      return null; // GET请求返回null（原代码逻辑）
    } else {
      // 对于非GET请求，返回解析后的body数据
      return body ? new TextEncoder().encode(body) : new Uint8Array();
    }
  } catch (error) {
    if (log.error) {
      await log.error('QStash 签名验证错误', {
        error: error.message,
        hasSignature: !!request.headers.get('Upstash-Signature'),
      });
    }
    throw new Error(`QStash 签名验证失败: ${error.message}`);
  }
}

/**
 * 验证 QStash 消息格式
 * @param {Object} body - 请求体
 * @param {Object} requestLogger - 请求日志器
 * @returns {Promise<boolean>} 验证是否成功
 */
async function validateQStashMessage(body, requestLogger = null) {
  const log = requestLogger || console;
  
  if (!body) {
    if (log.warn) await log.warn('QStash 消息为空', {});
    return false;
  }

  // QStash 消息通常包含以下字段
  const requiredFields = ['messageId', 'timestamp'];
  const missingFields = requiredFields.filter(field => !(field in body));
  
  if (missingFields.length > 0) {
    if (log.warn) {
      await log.warn('QStash 消息格式不完整', {
        missingFields,
        receivedFields: Object.keys(body),
      });
    }
    return false;
  }

  // 验证时间戳（防止重放攻击）
  const timestamp = body.timestamp;
  const now = Date.now();
  const messageTime = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  
  // 允许5分钟的时间偏差
  const timeDiff = Math.abs(now - messageTime);
  if (timeDiff > 5 * 60 * 1000) {
    if (log.warn) {
      await log.warn('QStash 消息时间戳异常', {
        messageTime,
        currentTime: now,
        timeDiff,
      });
    }
    return false;
  }

  if (log.debug) await log.debug('✅ QStash 消息格式验证通过', {});
  return true;
}

export { verifyQStashSignature, validateQStashMessage };
