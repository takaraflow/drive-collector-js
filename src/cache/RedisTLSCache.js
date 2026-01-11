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
    const { url, password, rejectUnauthorized, servername, ca, cert, key, db = 0 } = options;
    
    if (!url) {
      throw new Error('RedisTLSCache requires url option');
    }

    this.url = url;
    this.password = password;
    this.tlsOptions = {};

    if (url.startsWith('rediss://') || rejectUnauthorized !== undefined || servername || ca || cert || key) {
      this.tlsOptions.rejectUnauthorized = rejectUnauthorized !== false;
      if (servername) this.tlsOptions.servername = servername;
      if (ca) this.tlsOptions.ca = ca;
      if (cert) this.tlsOptions.cert = cert;
      if (key) this.tlsOptions.key = key;

      if (!this.tlsOptions.servername) {
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

        // Inject logger for internal debugging
        redisOptions.logger = (msg) => logger.debug(`[redis-on-workers] ${msg}`);
        
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
      await this.client.close();
      this.client = null;
      this.connectPromise = null;
      logger.info('RedisTLSCache disconnected');
    }
  }

  _decode(result) {
    if (result === null || result === undefined) return result;

    if (result instanceof Uint8Array)
      return new TextDecoder().decode(result).trim();
    else if (ArrayBuffer.isView(result)) {
      // ✅ 关键：只 decode 这段 view 的实际范围
      const u8 = new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
      return new TextDecoder().decode(u8).trim();
    } else if (result instanceof ArrayBuffer)
      return new TextDecoder().decode(new Uint8Array(result)).trim();
    
    return String(result).trim();
  }

  async get(key, type = "json") {
    if (!this.client) {
      await this.connect();
    }

    const result = await this.client.send('GET', key);
    if (result === null) return null;

    const value = this._decode(result);

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
    await this.client.send('SET', ...args);
    return true;
  }

  async delete(key) {
    if (!this.client) {
      await this.connect();
    }
    await this.client.send('DEL', key);
    return true;
  }

  async exists(key) {
    if (!this.client) {
      await this.connect();
    }
    const result = await this.client.send('EXISTS', key);
    return result === 1;
  }

  async incr(key) {
    if (!this.client) {
      await this.connect();
    }
    return await this.client.send('INCR', key);
  }

  async lock(key, ttl = 60) {
    if (!this.client) {
      await this.connect();
    }
    const result = await this.client.send('SET', key, 'locked', 'NX', 'EX', ttl);
    return result === 'OK';
  }

  async unlock(key) {
    return await this.delete(key);
  }

  async listKeys(prefix = '', limit = 1000, ctx = null) {
    if (!this.client) {
      await this.connect();
    }

    const log = ctx?.logBuffer ? logger.child({ logBuffer: ctx.logBuffer }) : logger;
    const keys = [];
    let cursor = '0';
    let nextCursorArg = '0';

    try {
      do {
        const args = [nextCursorArg];
        if (prefix) {
          args.push('MATCH', prefix + '*');
        } else {
          args.push('MATCH', '*');
        }
        const remaining = limit - keys.length;
        if (remaining <= 0) break;
        args.push('COUNT', String(Math.min(100, remaining)));

        const res = await this.client.send('SCAN', ...args);
        
        if (!Array.isArray(res) || res.length !== 2 || !Array.isArray(res[1])) {
          log.error('Invalid SCAN response structure', { res });
          throw new Error('Invalid SCAN response');
        }

        const rawCursor = res[0];
        const oldCursor = cursor;
        const decoded = this._decode(rawCursor);

        // 只保留数字，避免 \0 / \r / 乱码导致 invalid cursor
        const m = decoded && decoded.match(/^\d+$/);
        cursor = m ? m[0] : '0';
        nextCursorArg = cursor;
        
        log.debug('SCAN iteration', {
          cursorSent: oldCursor,
          rawCursorType: typeof rawCursor,
          rawCursorIsBuffer: rawCursor instanceof Uint8Array,
          cursorReceived: cursor,
          keysFound: res[1].length
        });

        const batch = res[1].map(k => this._decode(k));
        keys.push(...batch);

        if (keys.length >= limit) {
          break;
        }
      } while (cursor !== '0');
    } catch (error) {
      log.error('Redis SCAN error', { error: error.message, cursor });
      throw error;
    }

    return keys.slice(0, limit);
  }

  async ping() {
    if (!this.client) {
      await this.connect();
    }
    return await this.client.send('PING');
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
