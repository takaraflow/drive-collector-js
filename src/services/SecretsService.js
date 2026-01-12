import InfisicalSecretsProvider from './secrets/InfisicalSecretsProvider.js';

export async function getInfisicalSecrets() {
    try {
        const provider = new InfisicalSecretsProvider({
            token: process.env.INFISICAL_TOKEN,
            clientId: process.env.INFISICAL_CLIENT_ID,
            clientSecret: process.env.INFISICAL_CLIENT_SECRET,
            projectId: process.env.INFISICAL_PROJECT_ID,
            envName: process.env.INFISICAL_ENV || 'dev'
        });
        
        const secrets = await provider.fetchSecrets();
        return secrets;
    } catch (error) {
        console.error('InfisicalSecretsProvider Error:', error.message);
        throw error;
    }
}
