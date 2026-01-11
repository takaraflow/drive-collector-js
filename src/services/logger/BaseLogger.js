/**
 * BaseLogger - Abstract base class for all logger providers
 * Defines the standard interface that all logger implementations must follow
 */
class BaseLogger {
    constructor(options = {}) {
        if (this.constructor === BaseLogger) {
            throw new Error("BaseLogger is an abstract class and cannot be instantiated directly");
        }
        this.options = options;
        this.isInitialized = false;
        this.connected = false;
        this.providerName = this.constructor.name;
    }

    /**
     * Initialize the logger provider
     * @returns {Promise<void>}
     */
    async initialize() {
        this.isInitialized = true;
    }

    /**
     * Connect to the logger provider
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
     * Disconnect from the logger provider
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
     * Log an info message
     * @param {string} message - The log message
     * @param {Object} data - Additional data
     * @param {Object} context - Context fields
     * @returns {Promise<void>}
     */
    async info(message, data = {}, context = {}) {
        throw new Error('Not implemented');
    }

    /**
     * Log a warning message
     * @param {string} message - The log message
     * @param {Object} data - Additional data
     * @param {Object} context - Context fields
     * @returns {Promise<void>}
     */
    async warn(message, data = {}, context = {}) {
        throw new Error('Not implemented');
    }

    /**
     * Log an error message
     * @param {string} message - The log message
     * @param {Object} data - Additional data
     * @param {Object} context - Context fields
     * @returns {Promise<void>}
     */
    async error(message, data = {}, context = {}) {
        throw new Error('Not implemented');
    }

    /**
     * Log a debug message
     * @param {string} message - The log message
     * @param {Object} data - Additional data
     * @param {Object} context - Context fields
     * @returns {Promise<void>}
     */
    async debug(message, data = {}, context = {}) {
        throw new Error('Not implemented');
    }

    /**
     * Flush any buffered logs
     * @param {number} timeoutMs - Timeout in milliseconds
     * @returns {Promise<void>}
     */
    async flush(timeoutMs = 10000) {
        if (this._flush) {
            return await this._flush(timeoutMs);
        }
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

export { BaseLogger };
