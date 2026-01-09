import { Client, Receiver } from "@upstash/qstash";
import { getConfig } from "../../config/index.js";
import { logger } from "../../services/logger.js";
import { CircuitBreakerManager } from "../../services/CircuitBreaker.js";
import { BaseQueue } from "./BaseQueue.js";

const log = logger.withModule?.('QstashQueue') || logger;

export class QstashQueue extends BaseQueue {
    constructor(options = {}) {
        super(options);
        this.client = null;
        this.receiver = null;
        this.isMockMode = true;
        this.publishBreaker = CircuitBreakerManager.get('qstash_publish', {
            failureThreshold: 3,
            successThreshold: 2,
            timeout: 10000
        });
    }

    async initialize() {
        await super.initialize();
        const config = getConfig();

        if (!config.qstash?.token) {
            log.warn('QStash Token 未找到，使用模拟模式');
            this.isMockMode = true;
        } else {
            this.client = new Client({ token: config.qstash.token });
            this.isMockMode = false;
        }

        this.receiver = new Receiver({
            currentSigningKey: config.qstash.currentSigningKey,
            nextSigningKey: config.qstash.nextSigningKey
        });

        await this.connect();
    }

    async _connect() {
        log.info(`QstashQueue connected (Mode: ${this.isMockMode ? 'Mock' : 'Real'})`);
    }

    async _publish(topic, message, options = {}) {
        if (this.isMockMode) return { messageId: "mock-message-id" };

        return this.publishBreaker.execute(
            () => this._executeWithRetry(async () => {
                const result = await this.client.publishJSON({
                    url: topic,
                    body: message,
                    ...options
                });
                log.info(`Qstash Published, MsgID: ${result.messageId}`);
                return result;
            }, "publish"),
            () => ({ messageId: "fallback-message-id", fallback: true })
        );
    }

    async _batchPublish(messages) {
        if (this.isMockMode) {
            return messages.map(() => ({ messageId: "mock-message-id" }));
        }

        return this.publishBreaker.execute(
            () => this._executeBatch(messages),
            () => messages.map(() => ({ messageId: "fallback-message-id", fallback: true }))
        );
    }

    async _executeBatch(messages) {
        const results = await Promise.allSettled(messages.map(async (msg) => {
            return this._executeWithRetry(async () => {
                return await this.client.publishJSON({
                    url: msg.topic,
                    body: msg.message
                });
            }, "batchPublish");
        }));
        return results;
    }

    async _verifyWebhook(signature, body) {
        if (this.isMockMode) return true;
        if (!signature) {
            log.warn('Signature verification failed: missing signature');
            return false;
        }
        try {
            await this.receiver.verify({ signature, body });
            return true;
        } catch (error) {
            log.error('Signature verification failed', error);
            return false;
        }
    }

    async _executeWithRetry(operation, operationName) {
        const maxRetries = 3;
        const baseDelay = 100;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                const errorCode = this._extractErrorCode(error.message);
                if (errorCode && errorCode >= 400 && errorCode < 500) throw error;
                if (attempt === maxRetries) throw error;

                const jitter = process.env.NODE_ENV === 'test' ? 25 : Math.random() * 50;
                const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
                log.warn(`${operationName} attempt ${attempt} failed, retrying in ${delay.toFixed(0)}ms`);

                if (process.env.NODE_ENV === 'test' && typeof jest !== 'undefined') {
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
    }

    _extractErrorCode(errorMessage) {
        const match = errorMessage.match(/(\d{3})/);
        return match ? parseInt(match[1]) : null;
    }

    getCircuitBreakerStatus() {
        return this.publishBreaker.getStatus();
    }

    resetCircuitBreaker() {
        this.publishBreaker.reset();
    }
}
