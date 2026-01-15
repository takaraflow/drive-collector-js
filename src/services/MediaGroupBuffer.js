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
            useLocalTimers: options.useLocalTimers ?? process.env.NODE_ENV !== "test",
            remoteFlushEnabled: options.remoteFlushEnabled ?? process.env.NODE_ENV !== "test",
            ...options
        };

        this.baseKey = this.options.persistKeyPrefix;
        this.indexKey = `${this.baseKey}:index`;

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

    async _readIndex() {
        const data = await cache.get(this.indexKey, "json");
        if (!data || !Array.isArray(data.gids)) return { gids: [] };
        return data;
    }

    async _updateIndex(mutator) {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            const current = await this._readIndex();
            const next = mutator(current);
            const ok = await cache.compareAndSet(this.indexKey, next, {
                ifNotExists: false,
                ifEquals: current
            });
            if (ok) return true;
        }

        const current = await this._readIndex();
        const next = mutator(current);
        await cache.set(this.indexKey, next, this.options.staleThreshold / 1000);
        return false;
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

        const bufferSize = await this._addMessageToBuffer(gid, message, target, userId);
        if (bufferSize >= this.options.maxBatchSize) {
            this._clearLocalFlushTimer(gid);
            await this._attemptFlush(gid);
            return { added: true, reason: "flush_triggered" };
        }

        await this._startTimeoutTimer(gid);
        this._scheduleLocalFlush(gid);
        await this._scheduleRemoteFlush(gid);

        this.localBufferKeys.add(gid);
        this.messageIds.set(msgId, Date.now());
        await this._updateIndex((current) => {
            if (current.gids.includes(gid)) return current;
            return { ...current, gids: [...current.gids, gid] };
        });

        return { added: true, reason: "buffered" };
    }

    async _scheduleRemoteFlush(gid) {
        if (!this.options.remoteFlushEnabled) return;

        try {
            const { queueService } = await import("./QueueService.js");
            const delaySeconds = Math.max(1, Math.ceil((this.options.bufferTimeout + 200) / 1000));
            await queueService.publish(
                "system-events",
                {
                    event: "media_group_flush",
                    gid,
                    baseKey: this.baseKey
                },
                { delay: `${delaySeconds}s` }
            );
        } catch (error) {
            log.warn("Failed to schedule remote media group flush event", { gid, error: error?.message });
        }
    }

    async handleFlushEvent(event = {}) {
        const gid = event.gid?.toString?.();
        if (!gid) return false;

        const timer = await cache.get(this._timerKey(gid), "json");
        const now = Date.now();

        if (timer?.expiresAt && now < timer.expiresAt) {
            const delayMs = Math.max(200, timer.expiresAt - now + 200);
            try {
                const { queueService } = await import("./QueueService.js");
                const delaySeconds = Math.max(1, Math.ceil(delayMs / 1000));
                await queueService.publish(
                    "system-events",
                    { event: "media_group_flush", gid, baseKey: this.baseKey },
                    { delay: `${delaySeconds}s` }
                );
            } catch (error) {
                log.warn("Failed to reschedule media group flush event", { gid, error: error?.message });
            }
            return true;
        }

        return await this._attemptFlush(gid);
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

    async _addMessageToBuffer(gid, message, target, userId) {
        const bufferKey = this._bufferKey(gid);
        const now = Date.now();

        const messageData = {
            id: message.id,
            media: message.media,
            groupedId: message.groupedId,
            _bufferedAt: now,
            _seq: now
        };

        for (let attempt = 0; attempt < 5; attempt += 1) {
            const current = await cache.get(bufferKey, "json");
            const currentMessages = Array.isArray(current?.messages) ? current.messages : [];
            const exists = currentMessages.some((m) => m?.id?.toString?.() === message.id.toString());
            if (exists) return currentMessages.length;

            const nextMessages = [...currentMessages, messageData];
            const next = {
                target: current?.target || target,
                userId: current?.userId || userId,
                createdAt: current?.createdAt || now,
                updatedAt: now,
                messages: nextMessages
            };

            const ok = await cache.compareAndSet(bufferKey, next, current ? { ifEquals: current } : { ifNotExists: true });
            if (ok) return nextMessages.length;
        }

        // Best-effort fallback
        const current = await cache.get(bufferKey, "json");
        const currentMessages = Array.isArray(current?.messages) ? current.messages : [];
        const nextMessages = [...currentMessages, messageData];
        await cache.set(
            bufferKey,
            {
                target: current?.target || target,
                userId: current?.userId || userId,
                createdAt: current?.createdAt || now,
                updatedAt: now,
                messages: nextMessages
            },
            this.options.staleThreshold / 1000
        );
        return nextMessages.length;
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

            const { messages, meta } = await this._getBuffer(gid);
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

            const { meta } = await this._getBuffer(gid);
            if (meta) {
                meta.errorCount = (meta.errorCount || 0) + 1;
                await cache.set(this._bufferKey(gid), { ...meta, messages: meta.messages || [] }, this.options.staleThreshold / 1000);

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
        const { messages } = await this._getBuffer(gid);
        return messages;
    }

    async _getBuffer(gid) {
        const bufferKey = this._bufferKey(gid);
        const data = await cache.get(bufferKey, "json");
        if (!data) return { meta: null, messages: [] };
        const messages = Array.isArray(data.messages) ? data.messages : [];
        const meta = {
            target: data.target,
            userId: data.userId,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            errorCount: data.errorCount,
            messages
        };
        return { meta, messages };
    }

    _validateMediaGroup(messages) {
        if (!messages || messages.length === 0) return { isValid: false, reason: "empty_buffer" };
        const allHaveMedia = messages.every((m) => m.media);
        if (!allHaveMedia) return { isValid: false, reason: "missing_media" };
        return { isValid: true };
    }

    async _cleanupBuffer(gid) {
        const bufferKey = this._bufferKey(gid);
        await cache.delete(bufferKey);

        this.localBufferKeys.delete(gid);
        this._clearLocalFlushTimer(gid);
        await cache.delete(this._timerKey(gid));
        await this._updateIndex((current) => ({ ...current, gids: current.gids.filter((x) => x !== gid) }));
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
            const index = await this._readIndex();
            const now = Date.now();

            for (const gid of index.gids) {
                const timerData = await cache.get(this._timerKey(gid), "json");
                if (timerData && now > timerData.expiresAt) {
                    log.warn(`Cleaning up stale buffer: ${gid}`);
                    await this._attemptFlush(gid);
                }
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

            const index = await this._readIndex();
            for (const gid of index.gids) {
                const { meta, messages } = await this._getBuffer(gid);
                if (!meta) continue;

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
            const index = await this._readIndex();
            for (const gid of index.gids) {
                const { meta } = await this._getBuffer(gid);
                if (!meta) continue;
                if (Date.now() - (meta.createdAt || 0) > this.options.staleThreshold) continue;
                await this._attemptFlush(gid);
            }

            const data = await cache.get(this.persistKey, "json");
            if (!data?.buffers?.length) return;

            for (const bufferData of data.buffers) {
                if (Date.now() - bufferData.createdAt > this.options.staleThreshold) continue;

                for (const message of bufferData.messages) {
                    await this._addMessageToBuffer(
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
            const index = await this._readIndex();

            let totalMessages = 0;
            for (const gid of index.gids) {
                const { messages } = await this._getBuffer(gid);
                totalMessages += messages.length;
            }

            const lockStats = await this.distributedLock.getStats();

            return {
                instanceId: this.options.instanceId,
                activeBuffers: index.gids.length,
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
