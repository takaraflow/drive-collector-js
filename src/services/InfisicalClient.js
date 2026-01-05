import { InfisicalSDK } from '@infisical/sdk';

/**
 * 从 Infisical 动态拉取秘密 (不落盘)
 */
export async function fetchInfisicalSecrets({ clientId, clientSecret, projectId, envName = 'dev' }) {
    try {
        const infisicalSdk = new InfisicalSDK({
            siteUrl: 'https://app.infisical.com'
        });

        // 身份验证
        if (process.env.INFISICAL_TOKEN) {
            // Service Token 认证
            infisicalSdk.auth().accessToken(process.env.INFISICAL_TOKEN);
            console.info('ℹ️ InfisicalClient: Using Service Token');
        } else if (clientId && clientSecret) {
            // Machine Identity 认证
            await infisicalSdk.auth().universalAuth.login({
                clientId,
                clientSecret
            });
            console.info('ℹ️ InfisicalClient: Using Machine Identity');
        }

        // 获取秘密
        const response = await infisicalSdk.secrets().listSecrets({
            environment: envName,
            projectId: projectId,
            secretPath: '/',
            includeImports: true
        });

        if (response && response.secrets) {
            const secretsMap = {};
            response.secrets.forEach(s => {
                secretsMap[s.secretKey] = s.secretValue;
            });
            console.info(`✅ InfisicalClient: Successfully fetched ${Object.keys(secretsMap).length} secrets`);
            return secretsMap;
        }

        return {};
    } catch (error) {
        console.error('❌ InfisicalClient Error:', error.message);
        throw error;
    }
}

export default { fetchInfisicalSecrets };
