import { NFCacheClient } from './nf-cache-client.js';

let nfCacheClientInstance = null;

/**
 * 获取 NF 缓存客户端单例
 * @param {Object} env - 环境变量
 * @returns {NFCacheClient} NFCacheClient 实例
 * @throws 当 NF_REDIS_URL 未配置时抛出错误
 */
export function getNFCacheClient(env) {
  if (!nfCacheClientInstance) {
    nfCacheClientInstance = new NFCacheClient(env);
  }
  return nfCacheClientInstance;
}

/**
 * 清除缓存客户端实例（主要用于测试）
 */
export function clearNFCacheClient() {
  nfCacheClientInstance = null;
}