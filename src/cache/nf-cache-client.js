import { CacheTLSClient } from './cache-tls-client.js';

export class NFCacheClient extends CacheTLSClient {
  /**
   * @param {Object} env
   * @param {string} env.NF_REDIS_URL
   * @param {string} [env.NF_REDIS_PASSWORD]
   * @param {boolean} [env.REDIS_TLS_REJECT_UNAUTHORIZED]
   * @param {string} [env.REDIS_TLS_CA]
   * @param {string} [env.REDIS_TLS_CA_CERT]
   * @param {string} [env.REDIS_TLS_CLIENT_CERT]
   * @param {string} [env.REDIS_TLS_CLIENT_KEY]
   * @param {string} [env.REDIS_TLS_SNI_SERVERNAME]
   */
  constructor(env) {
    if (!env.NF_REDIS_URL) {
      throw new Error('NF_REDIS_URL is not configured for NFCacheClient');
    }
    super(
      env.NF_REDIS_URL,
      env.NF_REDIS_PASSWORD,
      {
        rejectUnauthorized: env.REDIS_TLS_REJECT_UNAUTHORIZED,
        ca: env.REDIS_TLS_CA,
        caCert: env.REDIS_TLS_CA_CERT,
        clientCert: env.REDIS_TLS_CLIENT_CERT,
        clientKey: env.REDIS_TLS_CLIENT_KEY,
        sniServername: env.REDIS_TLS_SNI_SERVERNAME,
      }
    );
    this.providerName = 'LegacyRedis';
  }
}
