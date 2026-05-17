/**
 * FileCache - small persistent cache provider for the optional L3 layer.
 *
 * L3 is a local durability layer, not a distributed coordination primitive.
 * It intentionally implements only cache-style reads/writes/deletes.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { BaseCache } from './BaseCache.js';

class FileCache extends BaseCache {
    constructor(options = {}) {
        super(options);
        this.basePath = options.basePath || './data/cache/l3';
        this.defaultTtl = Number(options.ttl) > 0 ? Number(options.ttl) : 86400;
        this.providerName = 'FileCache';
    }

    async connect() {
        await fs.mkdir(this.basePath, { recursive: true });
        this.connected = true;
        this.isInitialized = true;
    }

    async initialize() {
        await this.connect();
    }

    async disconnect() {
        this.connected = false;
    }

    async get(key, type = 'json') {
        this._assertConnected();

        try {
            const entry = JSON.parse(await fs.readFile(this._entryPath(key), 'utf8'));
            if (entry.expiresAt && Date.now() > entry.expiresAt) {
                await this.delete(key);
                return null;
            }

            return this._deserializeValue(entry.value, type);
        } catch (error) {
            if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
            throw error;
        }
    }

    async set(key, value, ttl = this.defaultTtl) {
        this._assertConnected();

        const filePath = this._entryPath(key);
        const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
        const entry = {
            key,
            expiresAt: Date.now() + Math.max(1, Number(ttl) || this.defaultTtl) * 1000,
            value: this._serializeValue(value)
        };

        await fs.writeFile(tempPath, JSON.stringify(entry), 'utf8');
        await fs.rename(tempPath, filePath);
        return true;
    }

    async delete(key) {
        this._assertConnected();

        try {
            await fs.unlink(this._entryPath(key));
            return true;
        } catch (error) {
            if (error.code === 'ENOENT') return false;
            throw error;
        }
    }

    async exists(key) {
        return (await this.get(key, 'json')) !== null;
    }

    async listKeys(prefix = '') {
        this._assertConnected();

        const files = await fs.readdir(this.basePath).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        const keys = [];

        for (const file of files) {
            if (!file.endsWith('.json')) continue;

            try {
                const entry = JSON.parse(await fs.readFile(path.join(this.basePath, file), 'utf8'));
                if (entry.expiresAt && Date.now() > entry.expiresAt) {
                    await fs.unlink(path.join(this.basePath, file)).catch(() => {});
                    continue;
                }
                if (typeof entry.key === 'string' && entry.key.startsWith(prefix)) {
                    keys.push(entry.key);
                }
            } catch {
                // Ignore corrupt entries; get() also treats them as misses.
            }
        }

        return keys;
    }

    getConnectionInfo() {
        return {
            provider: this.getProviderName(),
            connected: this.connected,
            basePath: this.basePath
        };
    }

    _entryPath(key) {
        return path.join(this.basePath, `${createHash('sha256').update(key).digest('hex')}.json`);
    }

    _serializeValue(value) {
        if (Buffer.isBuffer(value)) {
            return { encoding: 'base64', data: value.toString('base64') };
        }
        if (typeof value === 'string') {
            return { encoding: 'text', data: value };
        }
        return { encoding: 'json', data: value };
    }

    _deserializeValue(value, type) {
        if (!value || typeof value !== 'object') return null;

        if (type === 'buffer') {
            if (value.encoding === 'base64') return Buffer.from(value.data, 'base64');
            if (value.encoding === 'text') return Buffer.from(value.data);
            return Buffer.from(JSON.stringify(value.data));
        }

        if (type === 'text') {
            if (value.encoding === 'text') return value.data;
            if (value.encoding === 'base64') return Buffer.from(value.data, 'base64').toString();
            return JSON.stringify(value.data);
        }

        if (value.encoding === 'base64') return Buffer.from(value.data, 'base64');
        return value.data;
    }

    _assertConnected() {
        if (!this.connected) {
            throw new Error('Not connected');
        }
    }
}

export { FileCache };
