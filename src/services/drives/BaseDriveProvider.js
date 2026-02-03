import { logger } from "../logger/index.js";

const log = logger.withModule ? logger.withModule('BaseDriveProvider') : logger;

/**
 * 网盘 Provider 抽象基类
 * 所有网盘实现必须继承此类并实现抽象方法
 */
export class BaseDriveProvider {
    /**
     * @param {string} type - 网盘类型标识
     * @param {string} name - 网盘显示名称
     */
    constructor(type, name) {
        if (new.target === BaseDriveProvider) {
            throw new Error('BaseDriveProvider is abstract and cannot be instantiated directly');
        }
        this.type = type;
        this.name = name;
    }

    /**
     * 获取绑定步骤配置
     * @returns {Array<{step: string, prompt: string, validator?: Function}>}
     */
    getBindingSteps() {
        throw new Error(`${this.type}: getBindingSteps() must be implemented`);
    }

    /**
     * 处理用户输入
     * @param {string} step - 当前步骤
     * @param {string} input - 用户输入
     * @param {Object} session - 会话数据
     * @returns {Promise<ActionResult>}
     */
    async handleInput(step, input, session) {
        throw new Error(`${this.type}: handleInput() must be implemented`);
    }

    /**
     * 验证配置
     * @param {Object} configData - 配置数据
     * @returns {Promise<ValidationResult>}
     */
    async validateConfig(configData) {
        throw new Error(`${this.type}: validateConfig() must be implemented`);
    }

    /**
     * 处理密码（如需要混淆）
     * @param {string} password - 原始密码
     * @returns {string} 处理后的密码
     */
    processPassword(password) {
        return password;
    }

    /**
     * 获取错误消息
     * @param {string} errorType - 错误类型
     * @returns {string} 错误消息
     */
    getErrorMessage(errorType) {
        return '未知错误';
    }

    /**
     * 获取验证配置时使用的 rclone 命令
     * @returns {string} rclone 命令 (默认 'about')
     */
    getValidationCommand() {
        return 'about';
    }

    /**
     * 获取连接字符串
     * @param {Object} config - 配置对象
     * @returns {string} rclone 连接字符串
     */
    getConnectionString(config) {
        const user = (config.user || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const pass = (config.pass || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `:${this.type},user="${user}",pass="${pass}":`;
    }

    /**
     * 获取 Provider 信息
     * @returns {{type: string, name: string}}
     */
    getInfo() {
        return { type: this.type, name: this.name };
    }
}

/**
 * 绑定步骤配置类
 */
export class BindingStep {
    constructor(step, prompt, validator = null) {
        this.step = step;
        this.prompt = prompt;
        this.validator = validator;
    }
}

/**
 * 操作结果类
 */
export class ActionResult {
    constructor(success, message, nextStep = null, data = null, reason = null) {
        this.success = success;
        this.message = message;
        this.nextStep = nextStep;
        this.data = data;
        this.reason = reason;
    }
}

/**
 * 验证结果类
 */
export class ValidationResult {
    constructor(success, reason = null, details = null) {
        this.success = success;
        this.reason = reason;
        this.details = details;
    }
}
