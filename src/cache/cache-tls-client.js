import { createRedis } from 'redis-on-workers';
import { ICacheClient } from './interfaces.js';
import { logger } from '../logger.js';

export class CacheTLSClient extends ICacheClient {
  /** @type {import('redis-on-workers').RedisClient | null} */
  client = null;
  /** @type {Promise<void> | null} */
  connectPromise = null;
  /** @type {string} */
  url;
  /** @type {string | undefined} */
  password;
  /** @type {Object} */
  tlsOptions;
  /** @type {string} */
  providerName = 'CacheTLS';

  /**
   * @param {string} url
   * @param {string} [password]
   * @param {Object} [tlsConfig]
   * @param {boolean} [tlsConfig.rejectUnauthorized]
   * @param {string} [tlsConfig.ca]
   * @param {string} [tlsConfig.caCert]
   * @param {string} [tlsConfig.clientCert]
   * @param {string} [tlsConfig.clientKey]
   * @param {string} [tlsConfig.sniServername]
   */
  constructor(url, password, tlsConfig) {
    super();
    this.url = url;
    this.password = password;
    this.tlsOptions = {};

    if (url.startsWith('rediss://')) {
      this.tlsOptions.rejectUnauthorized = CacheTLSClient._isStrictFalse(tlsConfig?.rejectUnauthorized) ? false : true;
      this.tlsOptions.ca = tlsConfig?.ca || tlsConfig?.caCert;
      this.tlsOptions.cert = tlsConfig?.clientCert;
      this.tlsOptions.key = tlsConfig?.clientKey;
      this.tlsOptions.servername = tlsConfig?.sniServername || new URL(url).hostname;
    }
  }

  static _isStrictFalse(value) {
    if (value === false) return true;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'false' || normalized === '0' || normalized === 'no';
    }
    return false;
  }

  async connect() {
    if (this.client) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        const redisOptions = {
          url: this.url,
          password: this.password,
        };

        if (this.url.startsWith('rediss://')) {
          redisOptions.tls = this.tlsOptions;
        }

        const client = createRedis(redisOptions);
        await client.send('PING');
        this.client = client;
        logger.info('✅ Cache TLS 客户端初始化成功 (Cache TLS Client initialized)', { host: this.tlsOptions.servername || new URL(this.url).hostname });
      } catch (e) {
        this.client = null;
        this.connectPromise = null;
        logger.error('❌ Cache TLS 客户端初始化失败 (Cache TLS Client initialization failed)', { error: e.message, url: this.url });
        throw e;
      }
    })();
    await this.connectPromise;
  }

  async disconnect() {
    if (this.client) {
      await this.client.close();
      this.client = null;
      this.connectPromise = null;
      logger.info('Cache TLS Client 已断开');
    }
  }

  /**
   * @param {string} command
   * @param {any[]} args
   * @returns {Promise<any>}
   */
  async sendCommand(command, args) {
    if (!this.client) {
      await this.connect();
      if (!this.client) throw new Error('Cache client not connected');
    }
    return await this.client.send(command, ...args);
  }

  /**
   * @param {string} key
   * @returns {Promise<string | null>}
   */
  async get(key) {
    const result = await this.sendCommand('GET', [key]);
    if (result === null) return null;
    if (result instanceof Uint8Array) {
      return new TextDecoder().decode(result);
    }
    if (ArrayBuffer.isView(result)) {
      return new TextDecoder().decode(result.buffer);
    }
    if (result instanceof ArrayBuffer) {
      return new TextDecoder().decode(new Uint8Array(result));
    }
    return String(result);
  }

  /**
   * @param {string} key
   * @param {string} value
   * @param {number} [ttl]
   * @returns {Promise<'OK' | null>}
   */
  async set(key, value, ttl) {
    const args = [key, value];
    if (ttl) {
      args.push('EX', ttl);
    }
    await this.sendCommand('SET', args);
    return 'OK';
  }

  /**
   * @param {string} cursor
   * @param {string} match
   * @param {number} count
   * @returns {Promise<[string, string[]]>}
   */
  async scan(cursor, match, count) {
    const res = await this.sendCommand('SCAN', [cursor, 'MATCH', match, 'COUNT', count]);
    if (!Array.isArray(res) || res.length !== 2 || !Array.isArray(res[1])) {
      throw new Error('Invalid SCAN response');
    }
    return [String(res[0]), res[1].map(String)];
  }

  /**
   * @returns {Promise<string>}
   */
  async ping() {
    return await this.sendCommand('PING', []);
  }

  getProviderName() {
    return this.providerName;
  }

  getConnectionInfo() {
    return {
      provider: this.providerName,
      connected: !!this.client,
      url: this.url,
      tls: typeof this.url === 'string' && this.url.startsWith('rediss://')
    };
  }

  async destroy() {
    await this.disconnect();
  }
}
