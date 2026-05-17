import { getConfig } from "../config/index.js";
import { logger } from "./logger/index.js";
import { QstashQueue } from "./queue/QstashQueue.js";
import { Mutex } from "async-mutex";
import Joi from 'joi';
import {
    buildDownloadQueueMessage,
    buildTaskQueueIdempotencyKey,
    buildTaskQueueMeta,
    buildUploadQueueMessage,
    normalizeTaskQueueAttempt,
    TASK_QUEUE_TRIGGER_SOURCES
} from "../domain/task-queue-contract.js";

const log = logger.withModule?.('QueueService') || logger;

let warnedMissingWebhookUrl = false;
let warnedQstashDebug = false;

function isQstashDebugEnabled() {
    const value = (getConfig().qstash?.debug || 'false').toLowerCase();
    return value === 'true' || value === '1' || value === 'yes';
}

function isTestRuntime(config = {}) {
    return (config.nodeEnv || 'dev') === 'test';
}

function isPlaceholderWebhookUrl(webhookUrl) {
    if (!webhookUrl) return true;
    try {
        const parsed = new URL(webhookUrl);
        return parsed.hostname === 'example.com';
    } catch {
        return true;
    }
}

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
        const runtimeConfig = getConfig();
        const existingMeta = (message && typeof message === 'object' && message._meta && typeof message._meta === 'object')
            ? message._meta
            : null;
        const baseMeta = buildTaskQueueMeta({}, {
            triggerSource: TASK_QUEUE_TRIGGER_SOURCES.QSTASH,
            instanceId: runtimeConfig.instance?.id?.slice(0, 8) || 'unknown'
        });

        if (runtimeConfig.callerTrackingMode === 'production') {
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
        if (options?.requireDurableAck && isPlaceholderWebhookUrl(webhookUrl) && !isTestRuntime(config)) {
            throw new Error('LB_WEBHOOK_URL is required for durable task queue publish');
        }
        if (!config.qstash?.webhookUrl && !warnedMissingWebhookUrl && (config.nodeEnv || 'dev') !== 'test') {
            warnedMissingWebhookUrl = true;
            log.warn('LB_WEBHOOK_URL 未配置，QStash 将发布到占位地址，回调不会到达你的 LB', {
                placeholder: webhookUrl
            });
        }
        const template = config.qstash?.pathTemplate || '/api/v2/tasks/${topic}';
        const urlPath = template.replace('${topic}', encodeURIComponent(topic.toLowerCase()));
        const fullUrl = `${webhookUrl}${urlPath}`;

        if (isQstashDebugEnabled() && !warnedQstashDebug && (config.nodeEnv || 'dev') !== 'test') {
            warnedQstashDebug = true;
            log.info('QStash debug enabled (QSTASH_DEBUG=true)');
        }

        if (isQstashDebugEnabled()) {
            log.debug('QueueService.publish', {
                topic,
                fullUrl,
                taskId: enhancedMessage?.taskId,
                messageType: enhancedMessage?.type,
                triggerSource: enhancedMessage?._meta?.triggerSource,
                forceDirect: Boolean(options?.forceDirect)
            });
        }

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
        const queueAttempt = normalizeTaskQueueAttempt(taskData?._meta?.queueAttempt);
        return this.publish(this.topics.downloadTasks, buildDownloadQueueMessage(taskId, taskData), {
            idempotencyKey: this._buildTaskIdempotencyKey(this.topics.downloadTasks, "download", taskId, queueAttempt),
            forceDirect: true,
            requireDurableAck: true
        });
    }

    async enqueueUploadTask(taskId, taskData = {}) {
        const queueAttempt = normalizeTaskQueueAttempt(taskData?._meta?.queueAttempt);
        return this.publish(this.topics.uploadTasks, buildUploadQueueMessage(taskId, taskData), {
            idempotencyKey: this._buildTaskIdempotencyKey(this.topics.uploadTasks, "upload", taskId, queueAttempt),
            forceDirect: true,
            requireDurableAck: true
        });
    }

    async close() {
        if (typeof this.queueProvider.close === 'function') {
            await this.queueProvider.close();
        } else if (typeof this.queueProvider.flush === 'function') {
            await this.queueProvider.flush();
        }
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

    _buildTaskIdempotencyKey(topic, type, taskId, queueAttempt) {
        return buildTaskQueueIdempotencyKey(topic, type, taskId, queueAttempt);
    }
}

export const queueService = new QueueService();
