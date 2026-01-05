
import { InfisicalSDK } from '@infisical/sdk';

/**
 * 从 Infisical 动态拉取秘密 (不落盘)
 */
export async function fetchInfisicalSecrets({ clientId, clientSecret, projectId, envName = 'dev' }) {
    try {
        const client = new InfisicalSDK({
            token: process.env.INFISICAL_TOKEN, // 优先使用 Service Token
            clientId: clientId, // 其次使用 Machine Identity
            clientSecret: clientSecret,
            siteURL: 'https://app.infisical.com' // 如果你的 Infisical 实例是自托管的，请修改此项
        });

        const secrets = await client.getAllSecrets({
            environment: envName,
            projectSlug: projectId, // Infisical SDK使用projectSlug，而不是workspaceId
            path: '/'
        });

        if (secrets && secrets.length > 0) {
            const secretsMap = {};
            secrets.forEach(s => {
                secretsMap[s.secretKey] = s.secretValue;
            });
            console.info(`✅ InfisicalClient: Successfully fetched ${Object.keys(secretsMap).length} secrets from environment: ${envName}`);
            return secretsMap;
        }

        return {};
    } catch (error) {
        console.error('❌ InfisicalClient Error:', error.message);
        // 在此处添加更详细的错误日志以帮助调试
        console.error(`[InfisicalClient Debug] ClientId: ${clientId}, ProjectId: ${projectId}, Env: ${envName}, Token Exists: ${!!process.env.INFISICAL_TOKEN}`);
        throw error;
    }
}

export default { fetchInfisicalSecrets };
