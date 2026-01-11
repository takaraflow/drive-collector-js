import { logger } from "../../services/logger/index.js";

const log = logger.withModule?.('BaseQueue') || logger;

/**
 * BaseQueue - Abstract base class for all queue providers
 * Defines the standard interface that all queue implementations must follow
 */
class BaseQueue {
    constructor(options = {}) {
        if (this.constructor === BaseQueue) {
            throw new Error("BaseQueue is an abstract class and cannot be instantiated directly");
        }
        this.options = options;
        this.isInitialized = false;
        this.connected = false;
        this.providerName = this.constructor.name;
    }

    /**
     * Initialize the queue provider
     * @returns {Promise<void>}
     */
    async initialize() {
        this.isInitialized = true;
    }

    /**
     * Connect to the queue provider
     * @returns {Promise<void>}
     */
    async connect() {
        if (this.connected) return;
        if (this._connect) {
            await this._connect();
        }
        this.connected = true;
    }

    /**
     * Disconnect from the queue provider
     * @returns {Promise<void>}
     */
    async disconnect() {
        if (!this.connected) return;
        if (this._disconnect) {
            await this._disconnect();
        }
        this.connected = false;
    }

    /**
     * Publish a message to a topic
     * @param {string} topic - The queue topic
     * @param {any} message - The message to publish
     * @param {Object} options - Additional options
     * @returns {Promise<Object>} - Result containing messageId
     */
    async publish(topic, message, options = {}) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._publish) {
            return await this._publish(topic, message, options);
        }
        throw new Error('Not implemented');
    }

    /**
     * Publish multiple messages in batch
     * @param {Array<{topic: string, message: any}>} messages - Array of messages
     * @returns {Promise<Array<Object>>} - Array of results
     */
    async batchPublish(messages) {
        if (!this.connected) {
            throw new Error('Not connected');
        }
        if (this._batchPublish) {
            return await this._batchPublish(messages);
        }
        throw new Error('Not implemented');
    }

    /**
     * Verify webhook signature
     * @param {string} signature - The webhook signature
     * @param {string} body - The webhook body
     * @returns {Promise<boolean>} - True if valid
     */
    async verifyWebhook(signature, body) {
        if (this._verifyWebhook) {
            return await this._verifyWebhook(signature, body);
        }
        throw new Error('Not implemented');
    }

    /**
     * Get current provider name
     * @returns {string} - Provider name
     */
    getProviderName() {
        return this.providerName;
    }

    /**
     * Get connection information
     * @returns {Object} - Connection info
     */
    getConnectionInfo() {
        return {
            provider: this.getProviderName(),
            connected: this.connected
        };
    }

    /**
     * Cleanup resources
     * @returns {Promise<void>}
     */
    async destroy() {
        await this.disconnect();
    }
}

export { BaseQueue };
