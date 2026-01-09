import { getConfig } from "../config/index.js";
import { logger } from "./logger.js";
import { QstashQueue } from "./queue/QstashQueue.js";

const log = logger.withModule?.('QueueService') || logger;

export class QueueService {
    constructor(queueProvider = null) {
        this.queueProvider = queueProvider || new QstashQueue();
        this.topics = {
            downloadTasks: "download",
            uploadTasks: "upload",
            systemEvents: "system-events"
        };
        this.isInitialized = false;
    }

    async initialize() {
        if (this.isInitialized) return;
        await this.queueProvider.initialize();
        this.isInitialized = true;
        log.info('QueueService initialized');
    }

    _addMetadata(message) {
        return {
            ...message,
            _meta: {
                triggerSource: 'direct-qstash',
                instanceId: process.env.INSTANCE_ID || 'unknown',
                timestamp: Date.now(),
                caller: new Error().stack.split('\n')[2]?.trim() || 'unknown'
            }
        };
    }

    async publish(topic, message, options = {}) {
        const enhancedMessage = this._addMetadata(message);
        const config = getConfig();
        const webhookUrl = config.qstash?.webhookUrl || 'https://example.com';
        const url = `${webhookUrl}/api/tasks/${topic}`;
        return this.queueProvider.publish(url, enhancedMessage, options);
    }

    async batchPublish(messages) {
        const config = getConfig();
        const webhookUrl = config.qstash?.webhookUrl || 'https://example.com';
        const enhancedMessages = messages.map(msg => ({
            topic: `${webhookUrl}/api/tasks/${msg.topic}`,
            message: this._addMetadata(msg.message)
        }));
        return this.queueProvider.batchPublish(enhancedMessages);
    }

    async enqueueDownloadTask(taskId, taskData = {}) {
        return this.publish(this.topics.downloadTasks, { taskId, type: 'download', ...taskData });
    }

    async enqueueUploadTask(taskId, taskData = {}) {
        return this.publish(this.topics.uploadTasks, { taskId, type: 'upload', ...taskData });
    }

    async broadcastSystemEvent(event, data = {}) {
        return this.publish(this.topics.systemEvents, { event, ...data });
    }

    async verifyWebhookSignature(signature, body) {
        return this.queueProvider.verifyWebhook(signature, body);
    }

    getCircuitBreakerStatus() {
        return this.queueProvider.getCircuitBreakerStatus?.() || null;
    }

    resetCircuitBreaker() {
        this.queueProvider.resetCircuitBreaker?.();
    }
}

export const queueService = new QueueService();
