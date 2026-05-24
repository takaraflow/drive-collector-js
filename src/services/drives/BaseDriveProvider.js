import { logger } from "../logger/index.js";
import { RCLONE_PASSWORD_FORMATS, normalizePasswordFormat, requiresRcloneObscuredPassword } from "../../domain/drive-credentials.js";

const log = logger.withModule ? logger.withModule('BaseDriveProvider') : logger;
const VALID_SUPPORT_LEVELS = new Set(['stable', 'advanced']);

export class DriveConfigValidationError extends Error {
    constructor(providerType, fields = []) {
        const missingFields = [...new Set(fields.filter(Boolean))];
        super(`Missing required drive config for ${providerType}: ${missingFields.join(', ')}`);
        this.name = 'DriveConfigValidationError';
        this.code = 'DRIVE_CONFIG_INVALID';
        this.providerType = providerType;
        this.fields = missingFields;
    }
}

/**
 * 网盘 Provider 抽象基类
 * 所有网盘实现必须继承此类并实现抽象方法
 */
export class BaseDriveProvider {
    /**
     * @param {string} type - 网盘类型标识
     * @param {string} name - 网盘显示名称
     * @param {{supportLevel?: string, supportNote?: string}} options - 支持成熟度信息
     */
    constructor(type, name, options = {}) {
        if (new.target === BaseDriveProvider) {
            throw new Error('BaseDriveProvider is abstract and cannot be instantiated directly');
        }
        this.type = type;
        this.name = name;
        this.supportLevel = options.supportLevel || 'advanced';
        if (!VALID_SUPPORT_LEVELS.has(this.supportLevel)) {
            throw new Error(`${type}: invalid supportLevel ${this.supportLevel}`);
        }
        this.supportNote = options.supportNote || '';
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
     * @returns {Promise<string>} 处理后的密码
     */
    async processPassword(password) {
        return password;
    }

    /**
     * 在持久化前规范化配置。
     * 默认直接返回原配置，子类可用于混淆敏感字段或补充 schema 信息。
     * @param {Object} configData
     * @returns {Promise<Object>}
     */
    async prepareConfigForStorage(configData) {
        return configData;
    }

    /**
     * 在运行时将持久化配置转换为 rclone 可直接使用的配置。
     * 默认直接返回原配置，子类可用于恢复/校验自定义敏感字段。
     * @param {Object} configData
     * @returns {Promise<Object>}
     */
    async prepareConfigForRuntime(configData) {
        return configData;
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
     * 获取在 rclone 中使用的后端类型名称
     * 默认返回此 Provider 的 type，子类可重写（例如 google_drive 需返回 'drive'）
     * @returns {string}
     */
    getRcloneBackendType() {
        return this.type;
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
        this.assertRequiredConfig(config, ['user', 'pass']);
        this.assertRclonePasswordReady(config);
        const user = (config.user || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const pass = (config.pass || "").replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        return `:${this.getRcloneBackendType()},user="${user}",pass="${pass}":`;
    }

    assertRclonePasswordReady(config = {}) {
        if (!requiresRcloneObscuredPassword(this.type) || !config.pass) return;
        const passFormat = normalizePasswordFormat(config.pass_format);
        if (passFormat !== RCLONE_PASSWORD_FORMATS.RCLONE_OBSCURED) {
            throw new DriveConfigValidationError(this.type, ['pass_format:rclone_obscured']);
        }
    }

    assertRequiredConfig(config = {}, fields = []) {
        const missing = fields.filter(field => {
            const value = config[field];
            return value === undefined || value === null || String(value).trim() === '';
        });
        if (missing.length > 0) {
            throw new DriveConfigValidationError(this.type, missing);
        }
    }

    /**
     * 获取用于管理面板展示的账号/目标标识。
     * @param {Object} config - 配置对象
     * @returns {string}
     */
    getDisplayAccount(config = {}) {
        return config.user || config.email || config.bucket || config.drive_id || 'configured';
    }

    /**
     * 获取 Provider 信息
     * @returns {{type: string, name: string}}
     */
    getInfo() {
        return {
            type: this.type,
            name: this.name,
            supportLevel: this.supportLevel,
            supportNote: this.supportNote
        };
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
