/**
 * 将 Node.js 环境名称映射到 Infisical 的环境 slug。
 * development -> dev
 * production -> prod
 * 其他 -> staging (默认)
 */
export function mapNodeEnvToInfisicalEnv(nodeEnv) {
    switch (nodeEnv) {
        case 'development':
            return 'dev';
        case 'production':
            return 'prod';
        default:
            return 'staging'; // 默认值，或者根据需要调整
    }
}
