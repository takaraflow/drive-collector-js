class BaseCache {
    constructor(options = {}) {
        if (this.constructor === BaseCache) {
            throw new Error("BaseCache is an abstract class and cannot be instantiated directly");
        }
        this.options = options;
        this.isInitialized = false;
        this.connected = false;
        this.providerName = this.constructor.name;
    }

    async initialize() {
        this.isInitialized = true;
    }

    async connect() {
        if (this.connected) return;
        if (this._connect) {
            await this._connect();
        }
        this.connected = true;
    }

    async disconnect() {
        if (!this.connected) return;
        if (this._disconnect) {
            await this._disconnect();
        }
        this.connected = false;
    }

    async get(key, type = "json") {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._get) {
            return await this._get(key, type);
        }
        throw new Error('Not implemented');
    }

    async set(key, value, ttl = 3600) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._set) {
            return await this._set(key, value, ttl);
        }
        throw new Error('Not implemented');
    }

    async delete(key) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._delete) {
            return await this._delete(key);
        }
        throw new Error('Not implemented');
    }

    async exists(key) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._exists) {
            return await this._exists(key);
        }
        throw new Error('Not implemented');
    }

    async incr(key) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._incr) {
            return await this._incr(key);
        }
        throw new Error('Not implemented');
    }

    async lock(key, ttl = 60) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._lock) {
            return await this._lock(key, ttl);
        }
        throw new Error('Not implemented');
    }

    async unlock(key) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._unlock) {
            return await this._unlock(key);
        }
        throw new Error('Not implemented');
    }

    async listKeys(prefix = '', limit = 1000) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._listKeys) {
            return await this._listKeys(prefix, limit);
        }
        throw new Error('Not implemented');
    }

    getProviderName() {
        return this.providerName;
    }

    getConnectionInfo() {
        return {
            provider: this.getProviderName(),
            connected: this.connected
        };
    }

    async destroy() {
    }
}

export { BaseCache };
