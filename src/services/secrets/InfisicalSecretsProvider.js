import CloudSecretsProvider from './CloudSecretsProvider.js';
import { InfisicalSDK } from '@infisical/sdk';

/**
 * Infisical 云配置提供者
 * 继承 CloudSecretsProvider 实现 Infisical 专有功能
 */
export default class InfisicalSecretsProvider extends CloudSecretsProvider {
    constructor(options) {
        super(options);
        
        // 初始化 Infisical SDK
        this.sdk = new InfisicalSDK({
            siteUrl: options.siteUrl || 'https://app.infisical.com'
        });
        
        this.authType = null;
    }

    /**
     * 身份验证
     */
    async authenticate() {
        const { token, clientId, clientSecret } = this.options;

        if (token) {
            // Service Token 认证
            this.sdk.auth().accessToken(token);
            this.authType = 'service_token';
            console.info('ℹ️ InfisicalSecretsProvider: Using Service Token');
        } else if (clientId && clientSecret) {
            // Machine Identity 认证
            await this.sdk.auth().universalAuth.login({
                clientId,
                clientSecret
            });
            this.authType = 'machine_identity';
            console.info('ℹ️ InfisicalSecretsProvider: Using Machine Identity');
        } else {
            throw new Error('No authentication credentials provided');
        }
    }

    /**
     * 获取配置（覆盖父类方法）
     * @returns {Promise<Object>} 配置对象
     */
    async fetchSecrets() {
        try {
            // 确保已认证
            if (!this.authType) {
                await this.authenticate();
            }

            const { projectId, envName = 'dev' } = this.options;

            if (!projectId) {
                throw new Error('Project ID is required');
            }

            // 获取秘密
            const response = await this.sdk.secrets().listSecrets({
                environment: envName,
                projectId: projectId,
                secretPath: '/',
                includeImports: true
            });

            // 验证响应
            this.validateResponse(response);

            // 解析并返回配置（使用父类通用方法）
            const secrets = this.parseSecrets(response);
            
            console.info(`✅ InfisicalSecretsProvider: Successfully fetched ${Object.keys(secrets).length} secrets`);
            return secrets;
        } catch (error) {
            console.error('❌ InfisicalSecretsProvider Error:', error.message);
            throw error;
        }
    }

    /**
     * 验证响应（覆盖父类方法）
     */
    validateResponse(response) {
        super.validateResponse(response);
        
        if (!response.secrets || !Array.isArray(response.secrets)) {
            throw new Error('Invalid Infisical response: missing secrets array');
        }
        
        return true;
    }

    /**
     * 设置 Webhook 监听器（可选功能）
     */
    setupWebhookListener() {
        // 实现 Infisical Webhook 监听逻辑
        // 这需要在 Infisical 中配置 Webhook URL
        console.warn('⚠️ Webhook listener not yet implemented');
    }

    /**
     * 获取配置版本信息
     * @returns {Promise<string>} 配置版本哈希
     */
    async getSecretVersion() {
        const secrets = await this.fetchSecrets();
        return this.hashSecrets(secrets);
    }
}