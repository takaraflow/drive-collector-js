export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

export const LOG_LEVEL_PRIORITY = Object.freeze({
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
});

export const defaultLogLevelForEnv = (nodeEnv = process.env.NODE_ENV) => {
    return nodeEnv === 'prod' || nodeEnv === 'production' ? 'info' : 'debug';
};

export const normalizeLogLevel = (level) => {
    if (typeof level !== 'string') return null;
    const normalized = level.trim().toLowerCase();
    if (normalized === 'warning') return 'warn';
    return Object.prototype.hasOwnProperty.call(LOG_LEVEL_PRIORITY, normalized) ? normalized : null;
};

export const getConfiguredLogLevel = () => {
    return normalizeLogLevel(process.env.LOG_LEVEL) || defaultLogLevelForEnv();
};

export const shouldSendLogLevel = (level) => {
    const normalized = normalizeLogLevel(level);
    if (!normalized) return false;

    const configured = getConfiguredLogLevel();
    return LOG_LEVEL_PRIORITY[normalized] <= LOG_LEVEL_PRIORITY[configured];
};
