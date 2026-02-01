import { BaseLogger } from './BaseLogger.js';
import { serializeToString } from '../../utils/serializer.js';

class ConsoleLogger extends BaseLogger {
    constructor(options = {}) {
        super(options);
        this.originalConsoleError = console.error;
        this.originalConsoleWarn = console.warn;
        this.originalConsoleLog = console.log;
        this.version = 'unknown';
        // 智能过滤模式：当启用外部日志平台时，控制台仅输出关键信息
        this.smartFilter = options.smartFilter || false;
    }

    async initialize() {
        if (this.isInitialized) return;
        await this._initVersion();
        this.isInitialized = true;
    }

    async _initVersion() {
        if (this.version !== 'unknown') return;
        try {
            if (process.env.APP_VERSION) {
                this.version = process.env.APP_VERSION;
                return;
            }
            // 尝试读取 package.json
            try {
                const { default: pkg } = await import('../../../package.json', { with: { type: 'json' } });
                this.version = pkg.version || 'unknown';
            } catch (e) {
                // Fallback for environments where dynamic import might fail or file missing
                this.version = 'unknown';
            }
        } catch (error) {
            // 如果连console都失败了，我们无能为力
            this.version = 'error';
        }
    }

    _formatMessage(level, message, data, context, instanceId) {
        const version = this.version;
        const env = process.env.NODE_ENV || 'prod';
        const mod = context?.module || 'System';

        // 简洁清晰的垂直分隔符格式，移除冗余的方括号
        // 如果 instanceId 是 'console' 则省略，否则展示
        const instPart = (instanceId && instanceId !== 'console' && instanceId !== 'unknown') ? ` | ${instanceId}` : '';

        return `${version} | ${env}${instPart} | ${mod} | ${message}`;
    }

    _getConsoleMethod(level) {
        const methods = {
            error: this.originalConsoleError,
            warn: this.originalConsoleWarn,
            log: this.originalConsoleLog
        };
        return methods[level] || this.originalConsoleLog;
    }

    /**
     * 判断是否为关键日志（用于智能过滤）
     */
    _isKeyLog(level, message, context) {
        // 1. 警告和错误总是关键日志
        if (level === 'warn' || level === 'error') return true;

        // 2. 如果明确禁用了智能过滤，则所有日志都放行（由 BaseLogger 的 level 检查控制）
        if (!this.smartFilter) return true;

        // 3. 检查白名单关键字（仅针对 INFO/DEBUG）
        const msgStr = (message || '').toString();

        // 关键状态图标
        if (['🚀', '✅', '❌', '⚠️', '🛑', '✨', '🔒', '👑'].some(icon => msgStr.includes(icon))) return true;

        // 关键服务状态
        const keyPatterns = [
            '启动', 'Start', 'start',
            '停止', 'Stop', 'stop',
            '成功', 'Success', 'success',
            '失败', 'Fail', 'fail',
            '就绪', 'Ready', 'ready',
            '连接', 'Connect', 'connect',
            '监听', 'Listening', 'listening',
            '版本', 'Version', 'version',
            '环境', 'Environment', 'env'
        ];

        // 忽略的常见噪音
        const ignorePatterns = [
            '锁续租', 'Heartbeat', 'Ping', 'UpdateConnectionState',
            'Task draining', 'circuit breaker', 'Watchdog'
        ];

        if (ignorePatterns.some(p => msgStr.includes(p))) return false;

        return keyPatterns.some(p => msgStr.includes(p));
    }

    async _log(level, message, data = {}, context = {}) {
        await this._initVersion();

        // 智能过滤检查
        if (!this._isKeyLog(level, message, context)) {
            return;
        }

        const instanceId = 'console';
        const formattedMessage = this._formatMessage(level, message, data, context, instanceId);
        const consoleMethod = this._getConsoleMethod(level);

        // 优化输出格式：强制单行显示
        // 之前的做法是传入对象 console.log(msg, obj)，导致 Node.js 自动展开多行
        // 现在的做法是将数据序列化为单行 JSON 字符串拼接在消息后面

        let finalLog = formattedMessage;

        // 如果有数据且不为空，追加序列化后的 JSON 字符串
        if (data && Object.keys(data).length > 0) {
            const details = serializeToString(data);
            finalLog += ` ${details}`;
        }

        // 直接输出字符串，避免控制台格式化展开
        consoleMethod(finalLog);
    }

    async info(message, data = {}, context = {}) {
        await this._log('info', message, data, context);
    }

    async warn(message, data = {}, context = {}) {
        await this._log('warn', message, data, context);
    }

    async error(message, data = {}, context = {}) {
        await this._log('error', message, data, context);
    }

    async debug(message, data = {}, context = {}) {
        await this._log('debug', message, data, context);
    }

    async flush() {
    }
}

export { ConsoleLogger };
