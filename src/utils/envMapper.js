/**
 * 规范化 NODE_ENV 值，将全拼形式转换为简写形式，同时保持向后兼容。
 * 支持的全拼和简写映射：
 * - development/dev -> dev
 * - production/prod -> prod
 * - staging/pre -> pre
 * - test -> test
 * 
 * @param {string} nodeEnv - 原始的 NODE_ENV 值
 * @returns {string} 规范化后的环境值
 */
export function normalizeNodeEnv(nodeEnv) {
    if (!nodeEnv) return 'dev';
    
    const env = nodeEnv.toLowerCase();
    switch (env) {
        case 'development':
        case 'dev':
            return 'dev';
        case 'production':
        case 'prod':
            return 'prod';
        case 'staging':
        case 'pre':
        case 'preview':
            return 'pre';
        case 'test':
            return 'test';
        default:
            return 'dev';
    }
}

/**
 * 将 Node.js 环境名称映射到 Infisical 的环境 slug。
 * dev -> dev
 * prod -> prod
 * pre -> pre
 * 
 * @param {string} nodeEnv - NODE_ENV 值（支持全拼或简写）
 * @returns {string} Infisical 环境名称
 */
export function mapNodeEnvToInfisicalEnv(nodeEnv) {
    const normalizedEnv = normalizeNodeEnv(nodeEnv);
    
    switch (normalizedEnv) {
        case 'dev':
            return 'dev';
        case 'prod':
            return 'prod';
        case 'pre':
            return 'pre';
        case 'test':
            return 'dev';
        default:
            return 'dev';
    }
}
