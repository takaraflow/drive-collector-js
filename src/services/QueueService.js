import { getConfig } from "../config/index.js";
import { logger } from "./logger/index.js";
import { QstashQueue } from "./queue/QstashQueue.js";
import { Mutex } from "async-mutex";
import Joi from 'joi';

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
        this.bufferMutex = new Mutex();
    }

    _addMetadata(message) {
        const CALLER_TRACKING_MODE = process.env.CALLER_TRACKING_MODE || 'none';
        const existingMeta = (message && typeof message === 'object' && message._meta && typeof message._meta === 'object')
            ? message._meta
            : null;
        const baseMeta = {
            triggerSource: 'qstash-v2',
            instanceId: process.env.INSTANCE_ID?.slice(0, 8) || 'unknown',
            timestamp: Date.now()
        };

        if (CALLER_TRACKING_MODE === 'production') {
            baseMeta.callerContext = new Error().stack
                .split('\n')
                .slice(2, 4)
                .map(line => line.trim());
        }

        return {
            ...message,
            _meta: existingMeta ? { ...baseMeta, ...existingMeta } : baseMeta
        };
    }

    async publish(topic, message, options = {}) {
        const enhancedMessage = this._addMetadata(message);
        const config = getConfig();
        const webhookUrl = config.qstash?.webhookUrl || 'https://example.com';
        const template = config.qstash?.pathTemplate || '/api/v2/tasks/${topic}';
        const urlPath = template.replace('${topic}', encodeURIComponent(topic.toLowerCase()));
        const fullUrl = `${webhookUrl}${urlPath}`;
        return this.queueProvider.publish(fullUrl, enhancedMessage, options);
    }

    async batchPublish(messages) {
        const MESSAGE_SCHEMA = Joi.array().items(
            Joi.object({
                topic: Joi.string()
                    .pattern(/^[a-z0-9_-]{1,64}$/i)
                    .required(),
                message: Joi.object()
                    .min(1)
                    .required()
            })
        ).min(1);

        const { error } = MESSAGE_SCHEMA.validate(messages, {
            abortEarly: false,
            allowUnknown: false
        });

        if (error) {
            const details = error.details.map(d => ({
                field: d.path.join('.'),
                message: d.message
            }));
            throw new Error(`Invalid message format: ${JSON.stringify(details)}`);
        }

        const config = getConfig();
        const webhookUrl = config.qstash?.webhookUrl || 'https://example.com';
        const template = config.qstash?.pathTemplate || '/api/v2/tasks/${topic}';
        
        const enhancedMessages = messages.map(msg => {
            const urlPath = template.replace('${topic}', encodeURIComponent(msg.topic.toLowerCase()));
            const fullUrl = `${webhookUrl}${urlPath}`;
            return {
                topic: fullUrl,
                message: this._addMetadata(msg.message)
            };
        });
        
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
        try {
            if (typeof this.queueProvider.resetCircuitBreaker !== 'function') {
                throw new Error('MethodNotImplementedError: resetCircuitBreaker');
            }
            
            const prevState = this.getCircuitBreakerStatus();
            const result = this.queueProvider.resetCircuitBreaker();
            
            return {
                success: true,
                previousState: prevState,
                currentState: this.getCircuitBreakerStatus(),
                timestamp: Date.now()
            };
        } catch (error) {
            log.withContext({
                errorStack: error.stack
            }).error('熔断器重置异常');
            
            return {
                success: false,
                errorCode: error.code || 'UNKNOWN_ERROR'
            };
        }
    }
}

export const queueService = new QueueService();
