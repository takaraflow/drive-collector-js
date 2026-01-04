
const INFISICAL_API_BASE = 'https://app.infisical.com/api/v3';

/**
 * 从 Infisical 动态拉取秘密 (不落盘)
 */
export async function fetchInfisicalSecrets({ clientId, clientSecret, projectId, envName = 'dev' }) {
    try {
        let authHeader = '';

        // 1. 优先检查环境变量中的 INFISICAL_TOKEN (Service Token)
        if (process.env.INFISICAL_TOKEN) {
            authHeader = `Bearer ${process.env.INFISICAL_TOKEN}`;
        } 
        // 2. 其次尝试使用 Machine Identity (ClientId/Secret)
        else if (clientId && clientSecret) {
            const loginResponse = await fetch(`${INFISICAL_API_BASE}/auth/universal-auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientId, clientSecret })
            });

            if (!loginResponse.ok) {
                throw new Error(`Auth failed: ${loginResponse.status}`);
            }

            const { accessToken } = await loginResponse.json();
            authHeader = `Bearer ${accessToken}`;
        } else {
            throw new Error('No authentication method provided (Token or ClientId/Secret)');
        }

        // 3. 获取秘密
        const url = new URL(`${INFISICAL_API_BASE}/secrets/raw`);
        url.searchParams.append('workspaceId', projectId);
        url.searchParams.append('environment', envName);
        url.searchParams.append('secretPath', '/');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时

        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: {
                'Authorization': authHeader,
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.warn(`[Infisical] Fetch secrets skipped/failed: ${response.status}`);
            return {};
        }

        const data = await response.json();
        
        if (data && data.secrets) {
            const secretsMap = {};
            data.secrets.forEach(s => {
                secretsMap[s.secretKey] = s.secretValue;
            });
            console.info(`✅ InfisicalClient: Successfully fetched ${Object.keys(secretsMap).length} secrets from environment: ${envName}`);
            return secretsMap;
        }

        return {};
    } catch (error) {
        console.error('❌ InfisicalClient Error:', error.message);
        throw error;
    }
}

export default { fetchInfisicalSecrets };
