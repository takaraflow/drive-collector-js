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
      this.tlsOptions.rejectUnauthorized = tlsConfig?.rejectUnauthorized === false ? false : true;
      this.tlsOptions.ca = tlsConfig?.ca || tlsConfig?.caCert;
      this.tlsOptions.cert = tlsConfig?.clientCert;
      this.tlsOptions.key = tlsConfig?.clientKey;
      this.tlsOptions.servername = tlsConfig?.sniServername || new URL(url).hostname;
    }
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
        logger.info('Cache TLS Client 初始化成功', { host: this.tlsOptions.servername || new URL(this.url).hostname });
      } catch (e) {
        this.client = null;
        this.connectPromise = null;
        logger.error('Cache TLS Client 初始化失败', { error: e.message, url: this.url });
        throw e;
      }
    })();
    await this.connectPromise;
  }

  async disconnect() {
    if (this.client) {
      await this.client.quit();
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
    return result === null ? null : String(result);
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
}