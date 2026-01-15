import { logger } from "./logger/index.js";
import { cache } from "./CacheService.js";
import { DistributedLock } from "./DistributedLock.js";
import { TaskManager } from "../processor/TaskManager.js";

const log = logger.withModule("MediaGroupBuffer");

class LRUCache {
    constructor(maxSize = 1000) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        this.cache.set(key, value);
    }

    has(key) {
        return this.cache.has(key);
    }

    delete(key) {
        return this.cache.delete(key);
    }

    get size() {
        return this.cache.size;
    }

    clear() {
        this.cache.clear();
    }

    getExpiredKeys(currentTime, maxAge) {
        const expired = [];
        for (const [key, timestamp] of this.cache) {
            if (currentTime - timestamp > maxAge) expired.push(key);
        }
        return expired;
    }
}

export class MediaGroupBuffer {
    constructor(options = {}) {
        this.options = {
            bufferTimeout: options.bufferTimeout || 1000,
            maxBatchSize: options.maxBatchSize || 10,
            cleanupInterval: options.cleanupInterval || 30000,
            staleThreshold: options.staleThreshold || 60000,
            instanceId: options.instanceId || process.env.INSTANCE_ID || "default",
            persistKeyPrefix: options.persistKeyPrefix || "media_group_buffer",
            lockTtl: options.lockTtl || 30,
            maxMessageIds: options.maxMessageIds || 1000,
            messageIdsMaxAge: options.messageIdsMaxAge || 3600000,
            useLocalTimers: options.useLocalTimers ?? (process.env.NODE_ENV !== "test" && !process.env.VITEST),
            ...options
        };

        this.baseKey = this.options.persistKeyPrefix;

        this.distributedLock = new DistributedLock(cache, {
            ttlSeconds: this.options.lockTtl,
            logger: log
        });

        this.localBufferKeys = new Set();
        this.messageIds = new LRUCache(this.options.maxMessageIds);
        this.localFlushTimers = new Map(); // gid -> timeoutId

        this.persistKey = `${this.options.instanceId}:${this.options.persistKeyPrefix}`;
        this.cleanupIntervalId = null;

        this.startCleanupTask();
    }

    _lockId(gid) {
        return `${this.baseKey}:lock:${gid}`;
    }

    _bufferKey(gid) {
        return `${this.baseKey}:buffer:${gid}`;
    }

    _timerKey(gid) {
        return `${this.baseKey}:timer:${gid}`;
    }

    _processedMessageKey(msgId) {
        return `${this.baseKey}:processed_messages:${msgId}`;
    }

    _gidFromKey(key) {
        const match = key.match(/:buffer:(.+):meta$/);
        if (!match) return null;
        return match[1];
    }

    _scheduleLocalFlush(gid) {
        if (!this.options.useLocalTimers) return;
        if (this.localFlushTimers.has(gid)) return;

        const timeoutId = setTimeout(() => {
            this.localFlushTimers.delete(gid);
            this._attemptFlush(gid).catch((error) => {
                log.error(`Local timer flush failed for group ${gid}:`, error);
            });
        }, this.options.bufferTimeout + 20);

        this.localFlushTimers.set(gid, timeoutId);
    }

    _clearLocalFlushTimer(gid) {
        const timeoutId = this.localFlushTimers.get(gid);
        if (!timeoutId) return;
        clearTimeout(timeoutId);
        this.localFlushTimers.delete(gid);
    }

    async add(message, target, userId) {
        const gid = message.groupedId.toString();
        const msgId = message.id.toString();

        const isDuplicate = await this._isMessageDuplicate(msgId);
        if (isDuplicate) {
            log.debug(`Duplicate message ignored: ${msgId}`);
            return { added: false, reason: "duplicate" };
        }

        await this._addMessageToRedis(gid, message, target, userId);

        const bufferSize = await this._getBufferSize(gid);
        if (bufferSize >= this.options.maxBatchSize) {
            this._clearLocalFlushTimer(gid);
            await this._attemptFlush(gid);
            return { added: true, reason: "flush_triggered" };
        }

        await this._startTimeoutTimer(gid);
        this._scheduleLocalFlush(gid);

        this.localBufferKeys.add(gid);
        this.messageIds.set(msgId, Date.now());

        return { added: true, reason: "buffered" };
    }

    async _attemptFlush(gid) {
        const lockId = this._lockId(gid);
        const lockResult = await this.distributedLock.acquire(lockId, this.options.instanceId);
        if (!lockResult.success) return false;

        await this._flushBufferWithLock(gid, lockResult.version);
        return true;
    }

    async _isMessageDuplicate(msgId) {
        const key = this._processedMessageKey(msgId);
        const exists = await cache.get(key, "string");
        if (exists) return true;
        await cache.set(key, "1", this.options.staleThreshold / 1000);
        return false;
    }

    async _addMessageToRedis(gid, message, target, userId) {
        const bufferKey = this._bufferKey(gid);

        const now = Date.now();
        const bufferData = {
            target,
            userId,
            createdAt: now,
            updatedAt: now
        };

        await cache.set(`${bufferKey}:meta`, bufferData, this.options.staleThreshold / 1000);

        const messageData = {
            id: message.id,
            media: message.media,
            groupedId: message.groupedId,
            _bufferedAt: now,
            _seq: now
        };

        await cache.set(`${bufferKey}:msg:${message.id}`, messageData, this.options.staleThreshold / 1000);

        const msgIdsKey = `${bufferKey}:msg_ids`;
        await cache.set(`${msgIdsKey}:${message.id}`, "1", this.options.staleThreshold / 1000);
    }

    async _getBufferSize(gid) {
        const bufferKey = this._bufferKey(gid);
        const keys = await cache.listKeys(`${bufferKey}:msg:*`);
        return keys.length;
    }

    async _startTimeoutTimer(gid) {
        const timerKey = this._timerKey(gid);
        const now = Date.now();
        const timerData = {
            expiresAt: now + this.options.bufferTimeout,
            updatedAt: now,
            instanceId: this.options.instanceId
        };
        await cache.set(timerKey, timerData, this.options.bufferTimeout / 1000 + 10);
    }

    async _flushBufferWithLock(gid, lockVersion) {
        const lockId = this._lockId(gid);

        try {
            const lockStatus = await this.distributedLock.getLockStatus(lockId);
            if (lockStatus.status !== "held" || lockStatus.owner !== this.options.instanceId || lockStatus.version !== lockVersion) {
                log.warn(`Lock lost for group ${gid}, skipping flush`);
                return;
            }

            const messages = await this._getAllMessages(gid);
            if (messages.length === 0) {
                log.warn(`Buffer empty for group ${gid}`);
                await this._cleanupBuffer(gid);
                return;
            }

            messages.sort((a, b) => a._seq - b._seq);

            const validation = this._validateMediaGroup(messages);
            if (!validation.isValid) {
                log.warn(`Media group ${gid} validation failed: ${validation.reason}`);
                setTimeout(() => {
                    this._attemptFlush(gid).catch((error) => log.error(`Retry flush failed for group ${gid}:`, error));
                }, this.options.bufferTimeout);
                return;
            }

            const bufferKey = this._bufferKey(gid);
            const meta = await cache.get(`${bufferKey}:meta`, "json");
            if (!meta) {
                log.error(`Missing metadata for group ${gid}`);
                await this._cleanupBuffer(gid);
                return;
            }

            await TaskManager.addBatchTasks(meta.target, messages, meta.userId);
            log.info(`Successfully processed media group ${gid} with ${messages.length} messages`);

            await this._cleanupBuffer(gid);
        } catch (error) {
            log.error(`Error flushing buffer for group ${gid}:`, error);

            const bufferKey = this._bufferKey(gid);
            const meta = await cache.get(`${bufferKey}:meta`, "json");
            if (meta) {
                meta.errorCount = (meta.errorCount || 0) + 1;
                await cache.set(`${bufferKey}:meta`, meta, this.options.staleThreshold / 1000);

                if (meta.errorCount < 3) {
                    setTimeout(() => {
                        this._attemptFlush(gid).catch((err) => log.error(`Retry flush failed for group ${gid}:`, err));
                    }, this.options.bufferTimeout * meta.errorCount);
                } else {
                    log.error(`Media group ${gid} failed after ${meta.errorCount} attempts`);
                    await this._cleanupBuffer(gid);
                }
            }
        } finally {
            this._clearLocalFlushTimer(gid);
            await this.distributedLock.release(lockId, this.options.instanceId);
        }
    }

    async _getAllMessages(gid) {
        const bufferKey = this._bufferKey(gid);
        const keys = await cache.listKeys(`${bufferKey}:msg:*`);
        const messages = [];

        for (const key of keys) {
            const message = await cache.get(key, "json");
            if (message) messages.push(message);
        }

        return messages;
    }

    _validateMediaGroup(messages) {
        if (!messages || messages.length === 0) return { isValid: false, reason: "empty_buffer" };
        const allHaveMedia = messages.every((m) => m.media);
        if (!allHaveMedia) return { isValid: false, reason: "missing_media" };
        return { isValid: true };
    }

    async _cleanupBuffer(gid) {
        const bufferKey = this._bufferKey(gid);
        const keys = await cache.listKeys(`${bufferKey}:*`);
        for (const key of keys) await cache.delete(key);

        this.localBufferKeys.delete(gid);
        this._clearLocalFlushTimer(gid);
        await cache.delete(this._timerKey(gid));
    }

    startCleanupTask() {
        this.cleanupIntervalId = setInterval(() => {
            this._cleanupStaleBuffers();
        }, this.options.cleanupInterval);
    }

    stopCleanup() {
        if (!this.cleanupIntervalId) return;
        clearInterval(this.cleanupIntervalId);
        this.cleanupIntervalId = null;
        log.info("MediaGroupBuffer cleanup task stopped");
    }

    async _cleanupStaleBuffers() {
        try {
            const timerKeys = await cache.listKeys(`${this.baseKey}:timer:*`);
            const now = Date.now();

            for (const timerKey of timerKeys) {
                const timerData = await cache.get(timerKey, "json");
                if (!timerData) continue;
                if (now <= timerData.expiresAt) continue;

                const gid = timerKey.split(":").slice(-1)[0];
                log.warn(`Cleaning up stale buffer: ${gid}`);
                await this._attemptFlush(gid);
            }

            const msgKeys = await cache.listKeys(`${this.baseKey}:processed_messages:*`);
            for (const key of msgKeys) {
                const value = await cache.get(key, "string");
                if (!value) await cache.delete(key);
            }

            this._cleanupLocalMessageIds();
        } catch (error) {
            const message = typeof error?.message === "string" ? error.message : "";
            if (message.includes("ECONNREFUSED") || message.includes("timeout")) {
                log.error("Cache connection error in cleanup task, stopping for 5 minutes");
                this.stopCleanup();
                setTimeout(() => {
                    if (!this.cleanupIntervalId) this.startCleanupTask();
                }, 300000);
            } else {
                log.error("Error in cleanup task:", error);
            }
        }
    }

    _cleanupLocalMessageIds() {
        const now = Date.now();
        const expiredKeys = this.messageIds.getExpiredKeys(now, this.options.messageIdsMaxAge);
        for (const key of expiredKeys) this.messageIds.delete(key);
        if (expiredKeys.length > 0) log.debug(`Cleaned up ${expiredKeys.length} expired message IDs from local cache`);
    }

    async persist() {
        try {
            const data = {
                instanceId: this.options.instanceId,
                timestamp: Date.now(),
                buffers: []
            };

            const metaKeys = await cache.listKeys(`${this.baseKey}:buffer:*:meta`);
            for (const metaKey of metaKeys) {
                const gid = this._gidFromKey(metaKey);
                if (!gid) continue;

                const meta = await cache.get(metaKey, "json");
                if (!meta) continue;

                const messages = await this._getAllMessages(gid);
                data.buffers.push({
                    gid,
                    target: meta.target,
                    userId: meta.userId,
                    messages: messages.map((m) => ({
                        id: m.id,
                        media: m.media,
                        groupedId: m.groupedId,
                        _seq: m._seq
                    })),
                    createdAt: meta.createdAt
                });
            }

            await cache.set(this.persistKey, data, 60);
            log.debug(`Persisted ${data.buffers.length} buffers`);
        } catch (error) {
            log.error("Failed to persist buffers:", error);
        }
    }

    async restore() {
        try {
            const metaKeys = await cache.listKeys(`${this.baseKey}:buffer:*:meta`);
            for (const metaKey of metaKeys) {
                const meta = await cache.get(metaKey, "json");
                if (!meta) continue;
                if (Date.now() - (meta.createdAt || 0) > this.options.staleThreshold) continue;

                const gid = this._gidFromKey(metaKey);
                if (!gid) continue;
                await this._attemptFlush(gid);
            }

            const data = await cache.get(this.persistKey, "json");
            if (!data?.buffers?.length) return;

            for (const bufferData of data.buffers) {
                if (Date.now() - bufferData.createdAt > this.options.staleThreshold) continue;

                for (const message of bufferData.messages) {
                    await this._addMessageToRedis(
                        bufferData.gid,
                        { id: message.id, media: message.media, groupedId: message.groupedId },
                        bufferData.target,
                        bufferData.userId
                    );
                }

                await this._attemptFlush(bufferData.gid);
            }
        } catch (error) {
            log.error("Failed to restore buffers:", error);
        }
    }

    async getStatus() {
        try {
            const metaKeys = await cache.listKeys(`${this.baseKey}:buffer:*:meta`);

            let totalMessages = 0;
            for (const metaKey of metaKeys) {
                const gid = this._gidFromKey(metaKey);
                if (!gid) continue;
                totalMessages += await this._getBufferSize(gid);
            }

            const lockStats = await this.distributedLock.getStats();

            return {
                instanceId: this.options.instanceId,
                activeBuffers: metaKeys.length,
                bufferedMessages: totalMessages,
                localBufferKeys: this.localBufferKeys.size,
                localMessageIds: this.messageIds.size,
                distributedLocks: lockStats
            };
        } catch (error) {
            log.error("Failed to get status:", error);
            return { instanceId: this.options.instanceId, error: error?.message };
        }
    }

    cleanup() {
        this.localBufferKeys.clear();
        this.messageIds.clear();
        for (const timeoutId of this.localFlushTimers.values()) clearTimeout(timeoutId);
        this.localFlushTimers.clear();
    }
}

const mediaGroupBuffer = new MediaGroupBuffer();
export default mediaGroupBuffer;
