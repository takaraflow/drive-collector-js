class CloudflareKVCache {
    constructor(config = {}) {
        this.accountId = config.accountId;
        this.namespaceId = config.namespaceId;
        this.token = config.token;
        this.apiUrl = '';
        this.REQUEST_TIMEOUT = 5000;
        this.providerName = 'CloudflareKV';
        this.connected = false;

        if (!this.accountId || !this.namespaceId || !this.token) {
            throw new Error('CloudflareKVCache requires accountId, namespaceId, and token');
        }

        this.apiUrl = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/storage/kv/namespaces/${this.namespaceId}`;
    }

    async connect() {
        this.connected = true;
    }

    async disconnect() {
        this.connected = false;
    }

    async _fetchWithTimeout(url, options = {}) {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT);

        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(id);
            return response;
        } catch (e) {
            clearTimeout(id);
            throw e;
        }
    }

    async get(key, type = "json") {
        try {
            const res = await this._fetchWithTimeout(
                `${this.apiUrl}/values/${key}`,
                {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                }
            );

            if (res.status === 404) return null;
            if (!res.ok) return null;

            const value = type === "json" ? await res.json() :
                         type === "text" ? await res.text() :
                         await res.arrayBuffer();

            return value;
        } catch (e) {
            return null;
        }
    }

    async set(key, value, ttl = 3600) {
        try {
            if (!ttl || ttl < 60) {
                console.warn(`[CloudflareKVCache] TTL ${ttl}s is below minimum (60s). Forcing to 60s.`);
                ttl = 60;
            }

            const url = new URL(`${this.apiUrl}/values/${key}`);
            url.searchParams.set('expiration_ttl', ttl.toString());

            const body = typeof value === 'string' ? value : JSON.stringify(value);

            const res = await this._fetchWithTimeout(url.toString(), {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${this.token}`,
                    'Content-Type': 'application/json'
                },
                body: body
            });

            if (!res.ok) throw new Error("Cache Set Error");
            return true;
        } catch (e) {
            console.error('[CloudflareKVCache] Set error:', e.message);
            return false;
        }
    }

    async delete(key) {
        try {
            await this._fetchWithTimeout(
                `${this.apiUrl}/values/${key}`,
                {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${this.token}` }
                }
            );
            return true;
        } catch (e) {
            return false;
        }
    }

    async exists(key) {
        try {
            const res = await this._fetchWithTimeout(
                `${this.apiUrl}/values/${key}`,
                {
                    method: 'HEAD',
                    headers: { 'Authorization': `Bearer ${this.token}` }
                }
            );
            return res.ok && res.status !== 404;
        } catch (e) {
            return false;
        }
    }

    async incr(key) {
        try {
            const current = await this.get(key, 'text');
            const value = current ? parseInt(current, 10) : 0;
            const newValue = value + 1;
            const success = await this.set(key, newValue.toString(), 3600);
            return success ? newValue : value;
        } catch (e) {
            return 0;
        }
    }

    async lock(key, ttl = 60) {
        console.warn('[CloudflareKVCache] ⚠️  SECURITY WARNING: KV is eventually consistent. Locks are NOT strictly safe. Use with caution!');

        try {
            const safeTtl = Math.max(60, ttl);
            const lockValue = `lock:${Date.now()}:${Math.random()}`;
            const success = await this.set(key, lockValue, safeTtl);
            if (!success) return false;

            const verify = await this.get(key, 'text');
            return verify === lockValue;
        } catch (e) {
            console.error('[CloudflareKVCache] Lock error:', e.message);
            return false;
        }
    }

    async unlock(key) {
        try {
            return await this.delete(key);
        } catch (e) {
            return false;
        }
    }

    async listKeys(prefix = '', limit = 1000) {
        let keys = [];
        let cursor = null;
        let list_complete = false;
        let totalFetched = 0;

        try {
            while (!list_complete) {
                const url = new URL(`${this.apiUrl}/keys`);
                if (prefix) url.searchParams.set('prefix', prefix);
                if (cursor) url.searchParams.set('cursor', cursor);

                const res = await this._fetchWithTimeout(url.toString(), {
                    headers: { 'Authorization': `Bearer ${this.token}` }
                });

                if (!res.ok) {
                    console.error(`[CloudflareKVCache] listKeys failed with status ${res.status}`);
                    return keys;
                }

                const data = await res.json();
                if (!data.success || !data.result) {
                    console.error('[CloudflareKVCache] listKeys response not successful');
                    return keys;
                }

                const newKeys = data.result.map(k => k.name);
                keys = keys.concat(newKeys);
                totalFetched += newKeys.length;

                if (data.result_info) {
                    list_complete = data.result_info.list_complete === true;
                    cursor = data.result_info.cursor;

                    if (!cursor && !list_complete) {
                        list_complete = true;
                    }
                } else {
                    list_complete = true;
                }

                if (limit > 0 && totalFetched >= limit) {
                    break;
                }

                if (!cursor && !list_complete) {
                    console.warn('[CloudflareKVCache] Missing cursor but list not marked complete, stopping');
                    break;
                }
            }

            return keys;
        } catch (e) {
            console.error('[CloudflareKVCache] listKeys error:', e.message);
            return keys;
        }
    }

    getProviderName() {
        return this.providerName;
    }

    getConnectionInfo() {
        return {
            provider: this.providerName,
            connected: this.connected
        };
    }

    async destroy() {
        await this.disconnect();
    }
}

export { CloudflareKVCache };
