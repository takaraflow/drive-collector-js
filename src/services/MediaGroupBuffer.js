import { logger } from "./logger/index.js";
import { cache } from "./CacheService.js";
import { TaskManager } from "../processor/TaskManager.js";

const log = logger.withModule('MediaGroupBuffer');

export class MediaGroupBuffer {
    constructor(options = {}) {
        this.options = {
            bufferTimeout: options.bufferTimeout || 1000,
            maxBatchSize: options.maxBatchSize || 10,
            cleanupInterval: options.cleanupInterval || 30000,
            staleThreshold: options.staleThreshold || 60000,
            persistKey: 'media_group_buffer',
            ...options
        };

        this.buffers = new Map();  // groupedId -> Buffer
        this.messageIds = new Set();  // 已处理的消息ID（去重）
        this.pendingPersists = new Set();  // 待持久化的缓冲区

        this.startCleanupTask();
    }

    /**
     * 添加消息到缓冲
     */
    async add(message, target, userId) {
        const gid = message.groupedId.toString();
        const msgId = message.id.toString();

        // 1. 消息去重检查
        if (this.messageIds.has(msgId)) {
            log.debug(`Duplicate message ignored: ${msgId}`);
            return { added: false, reason: 'duplicate' };
        }

        // 2. 获取或创建缓冲区
        let buffer = this.buffers.get(gid);

        if (!buffer) {
            buffer = this.createBuffer(gid, target, userId);
            this.buffers.set(gid, buffer);
        }

        // 3. 添加消息到缓冲区
        buffer.messages.push({
            ...message,
            _bufferedAt: Date.now(),
            _seq: buffer.messages.length,
            _msgId: msgId
        });
        this.messageIds.add(msgId);

        // 4. 检查是否达到批次大小
        if (buffer.messages.length >= this.options.maxBatchSize) {
            await this.flushBuffer(gid);
        }

        return { added: true, reason: 'buffered' };
    }

    /**
     * 创建缓冲区
     */
    createBuffer(gid, target, userId) {
        const timer = setTimeout(async () => {
            await this.flushBuffer(gid);
        }, this.options.bufferTimeout);

        // 允许定时器在后台运行，不阻止进程退出
        timer.unref();

        return {
            gid,
            target,
            userId,
            messages: [],
            timer,
            createdAt: Date.now(),
            flushed: false,
            errorCount: 0,
            _persistKey: `buffer:${gid}`
        };
    }

    /**
     * 刷新缓冲区
     */
    async flushBuffer(gid) {
        const buffer = this.buffers.get(gid);
        if (!buffer || buffer.flushed) return;

        // 标记为已刷新
        buffer.flushed = true;

        // 清除定时器
        if (buffer.timer) {
            clearTimeout(buffer.timer);
            buffer.timer = null;
        }

        try {
            // 排序消息（按 _seq）
            buffer.messages.sort((a, b) => a._seq - b._seq);

            // 验证消息完整性
            const validation = this.validateMediaGroup(buffer);

            if (!validation.isValid) {
                log.warn(`Media group ${gid} validation failed: ${validation.reason}`);

                // 延迟重试
                buffer.timer = setTimeout(() => {
                    buffer.flushed = false;
                    this.flushBuffer(gid);
                }, this.options.bufferTimeout);

                return;
            }

            // 处理媒体组
            await TaskManager.addBatchTasks(
                buffer.target,
                buffer.messages,
                buffer.userId
            );

            // 清理缓冲区
            this.removeBuffer(gid);

            // 从持久化中移除
            this.pendingPersists.delete(buffer._persistKey);

        } catch (error) {
            buffer.errorCount++;

            if (buffer.errorCount >= 3) {
                log.error(`Media group ${gid} failed after ${buffer.errorCount} attempts`);
                this.removeBuffer(gid);
                this.pendingPersists.delete(buffer._persistKey);
            } else {
                // 重试
                buffer.flushed = false;
                buffer.timer = setTimeout(() => {
                    this.flushBuffer(gid);
                }, this.options.bufferTimeout * buffer.errorCount);
            }
        }
    }

    /**
     * 验证媒体组完整性
     */
    validateMediaGroup(buffer) {
        if (!buffer.messages || buffer.messages.length === 0) {
            return { isValid: false, reason: 'empty_buffer' };
        }

        // 检查消息ID连续性
        const ids = buffer.messages.map(m => parseInt(m._msgId)).sort((a, b) => a - b);

        for (let i = 1; i < ids.length; i++) {
            if (ids[i] - ids[i - 1] > 1) {
                // 消息ID不连续，可能有消息还在路上
                return { isValid: false, reason: 'non_continuous_ids' };
            }
        }

        // 检查是否所有消息都有 media
        const allHaveMedia = buffer.messages.every(m => m.media);
        if (!allHaveMedia) {
            return { isValid: false, reason: 'missing_media' };
        }

        return { isValid: true };
    }

    /**
     * 移除缓冲区
     */
    removeBuffer(gid) {
        const buffer = this.buffers.get(gid);
        if (!buffer) return;

        // 清除定时器
        if (buffer.timer) {
            clearTimeout(buffer.timer);
            buffer.timer = null;
        }

        // 清理消息ID引用
        for (const msg of buffer.messages) {
            this.messageIds.delete(msg._msgId);
        }

        this.buffers.delete(gid);
    }

    /**
     * 启动清理任务
     */
    startCleanupTask() {
        setInterval(() => {
            this.cleanupStaleBuffers();
        }, this.options.cleanupInterval);
    }

    /**
     * 清理过期缓冲区
     */
    cleanupStaleBuffers() {
        const now = Date.now();
        const staleThreshold = this.options.staleThreshold;

        for (const [gid, buffer] of this.buffers) {
            // 已刷新的缓冲区
            if (buffer.flushed && !buffer.timer) {
                this.removeBuffer(gid);
                continue;
            }

            // 检查是否过期
            if (now - buffer.createdAt > staleThreshold) {
                log.warn(`Cleaning up stale buffer: ${gid}`);
                this.removeBuffer(gid);
                this.pendingPersists.delete(buffer._persistKey);
            }
        }
    }

    /**
     * 持久化缓冲区（用于重启恢复）
     */
    async persist() {
        try {
            const data = {
                buffers: Array.from(this.buffers.entries()).map(([gid, buffer]) => ({
                    gid,
                    target: buffer.target,
                    userId: buffer.userId,
                    messages: buffer.messages.map(m => ({
                        id: m.id,
                        media: m.media,
                        groupedId: m.groupedId,
                        _seq: m._seq,
                        _msgId: m._msgId
                    })),
                    createdAt: buffer.createdAt
                })),
                messageIds: Array.from(this.messageIds),
                timestamp: Date.now()
            };

            await cache.set(this.options.persistKey, data, 60);
            log.debug(`Persisted ${data.buffers.length} buffers`);
        } catch (error) {
            log.error('Failed to persist buffers:', error);
        }
    }

    /**
     * 恢复缓冲区（用于启动恢复）
     */
    async restore() {
        try {
            const data = await cache.get(this.options.persistKey, 'json');
            if (!data) return;

            // 恢复消息ID
            for (const msgId of data.messageIds) {
                this.messageIds.add(msgId);
            }

            // 恢复缓冲区
            for (const bufferData of data.buffers) {
                // 检查是否过期
                if (Date.now() - bufferData.createdAt > this.options.staleThreshold) {
                    continue;
                }

                // 创建缓冲区
                const buffer = this.createBuffer(bufferData.gid, bufferData.target, bufferData.userId);
                buffer.messages = bufferData.messages;
                buffer.createdAt = bufferData.createdAt;
                this.buffers.set(bufferData.gid, buffer);

                // 触发刷新
                this.flushBuffer(bufferData.gid);
            }

            log.info(`Restored ${data.buffers.length} media group buffers`);
        } catch (error) {
            log.error('Failed to restore buffers:', error);
        }
    }

    /**
     * 获取缓冲区状态
     */
    getStatus() {
        return {
            activeBuffers: this.buffers.size,
            bufferedMessages: this.messageIds.size,
            pendingPersists: this.pendingPersists.size
        };
    }
}

// 导出单例
const mediaGroupBuffer = new MediaGroupBuffer();
export default mediaGroupBuffer;