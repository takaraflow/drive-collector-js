import { createRedis } from 'redis-on-workers';
import { logger } from '../logger.js';

export class RedisTLSCache {
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
  providerName = 'RedisTLS';

  constructor(options = {}) {
    const { url, password, rejectUnauthorized, servername, db = 0 } = options;
    
    if (!url) {
      throw new Error('RedisTLSCache requires url option');
    }

    this.url = url;
    this.password = password;
    this.tlsOptions = {};

    if (url.startsWith('rediss://') || rejectUnauthorized !== undefined || servername) {
      this.tlsOptions.rejectUnauthorized = rejectUnauthorized !== false;
      if (servername) {
        this.tlsOptions.servername = servername;
      } else {
        try {
          this.tlsOptions.servername = new URL(url).hostname;
        } catch (e) {
        }
      }
    }
  }

  async connect() {
    if (this.client) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      try {
        const redisOptions = {
          url: this.url,
        };

        if (this.password) {
          redisOptions.password = this.password;
        }

        if (Object.keys(this.tlsOptions).length > 0) {
          redisOptions.tls = this.tlsOptions;
        }

        const client = createRedis(redisOptions);
        await client.send('PING');
        this.client = client;
        logger.info('RedisTLSCache initialized successfully', { 
          host: this.tlsOptions.servername || new URL(this.url).hostname 
        });
      } catch (e) {
        this.client = null;
        this.connectPromise = null;
        logger.error('RedisTLSCache initialization failed', { error: e.message, url: this.url });
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
      logger.info('RedisTLSCache disconnected');
    }
  }

  async get(key, type = "json") {
    if (!this.client) {
      await this.connect();
    }

    const result = await this.client.send('GET', [key]);
    if (result === null) return null;

    let value;
    if (result instanceof Uint8Array) {
      value = new TextDecoder().decode(result);
    } else if (ArrayBuffer.isView(result)) {
      value = new TextDecoder().decode(result.buffer);
    } else if (result instanceof ArrayBuffer) {
      value = new TextDecoder().decode(new Uint8Array(result));
    } else {
      value = String(result);
    }

    if (type === 'json') {
      try {
        return JSON.parse(value);
      } catch (e) {
        return value;
      }
    } else if (type === 'text') {
      return value;
    } else if (type === 'buffer') {
      return result instanceof Uint8Array ? result : new TextEncoder().encode(value);
    }
    return value;
  }

  async set(key, value, ttl = 3600) {
    if (!this.client) {
      await this.connect();
    }

    const body = typeof value === 'string' ? value : JSON.stringify(value);
    const args = [key, body];
    if (ttl) {
      args.push('EX', ttl);
    }
    await this.client.send('SET', args);
    return true;
  }

  async delete(key) {
    if (!this.client) {
      await this.connect();
    }
    await this.client.send('DEL', [key]);
    return true;
  }

  async exists(key) {
    if (!this.client) {
      await this.connect();
    }
    const result = await this.client.send('EXISTS', [key]);
    return result === 1;
  }

  async incr(key) {
    if (!this.client) {
      await this.connect();
    }
    return await this.client.send('INCR', [key]);
  }

  async lock(key, ttl = 60) {
    if (!this.client) {
      await this.connect();
    }
    const result = await this.client.send('SET', [key, 'locked', 'NX', 'EX', ttl]);
    return result === 'OK';
  }

  async unlock(key) {
    return await this.delete(key);
  }

  async listKeys(prefix = '', limit = 1000) {
    if (!this.client) {
      await this.connect();
    }

    const keys = [];
    let cursor = '0';

    while (cursor !== '0') {
      const args = [cursor];
      if (prefix) {
        args.push('MATCH', prefix + '*');
      } else {
        args.push('MATCH', '*');
      }
      args.push('COUNT', Math.min(100, limit - keys.length));

      const res = await this.client.send('SCAN', args);
      if (!Array.isArray(res) || res.length !== 2 || !Array.isArray(res[1])) {
        throw new Error('Invalid SCAN response');
      }

      cursor = String(res[0]);
      const batch = res[1].map(String);
      keys.push(...batch);

      if (keys.length >= limit) {
        break;
      }
    }

    return keys.slice(0, limit);
  }

  async ping() {
    if (!this.client) {
      await this.connect();
    }
    return await this.client.send('PING', []);
  }

  getProviderName() {
    return this.providerName;
  }

  getConnectionInfo() {
    return {
      provider: this.providerName,
      connected: !!this.client,
      tls: Object.keys(this.tlsOptions).length > 0
    };
  }

  validateTLS() {
    if (!this.tlsOptions || Object.keys(this.tlsOptions).length === 0) {
      logger.warn('RedisTLSCache: No TLS configuration found');
      return false;
    }

    if (this.tlsOptions.rejectUnauthorized === false) {
      logger.warn('RedisTLSCache: TLS verification is disabled (rejectUnauthorized: false)');
    }

    return true;
  }

  async destroy() {
    await this.disconnect();
  }
}
