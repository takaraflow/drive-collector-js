import fs from 'fs';
import path from 'path';
import { mapNodeEnvToInfisicalEnv, normalizeNodeEnv } from '../utils/envMapper.js';

function sanitizeRuntimeValue(value) {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    const markdownLink = trimmed.match(/^\[.*\]\((.+)\)$/);
    return markdownLink?.[1] || trimmed.replace(/^['"]|['"]$/g, '');
}

function parseDotenvLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return null;
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex <= 0) return null;

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

    return [key, sanitizeRuntimeValue(trimmed.slice(separatorIndex + 1))];
}

export function loadLocalRuntimeEnv() {
    const nodeEnv = normalizeNodeEnv(process.env.NODE_ENV);
    process.env.NODE_ENV = nodeEnv;

    const envFile = nodeEnv === 'dev' ? '.env' : `.env.${nodeEnv}`;
    const envPath = path.resolve(process.cwd(), envFile);
    if (!fs.existsSync(envPath)) return false;

    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    let loaded = 0;
    for (const line of lines) {
        const parsed = parseDotenvLine(line);
        if (!parsed) continue;
        const [key, value] = parsed;
        if (process.env[key] === undefined) {
            process.env[key] = value;
            loaded += 1;
        }
    }

    return loaded > 0;
}

function normalizeKeyGroups(keysOrGroups = []) {
    return keysOrGroups
        .map(item => Array.isArray(item) ? item : [item])
        .map(group => group.filter(Boolean));
}

function hasAnyKeyInGroup(group) {
    return group.some(key => {
        const value = process.env[key];
        return value !== undefined && value !== null && String(value).trim() !== '';
    });
}

function hasRequiredKeys(requiredKeys) {
    return normalizeKeyGroups(requiredKeys).every(hasAnyKeyInGroup);
}

function hasMissingHydrationKeys(keysOrGroups) {
    return normalizeKeyGroups(keysOrGroups).some(group => !hasAnyKeyInGroup(group));
}

async function loadInfisicalRuntimeEnv() {
    if (process.env.SKIP_INFISICAL_RUNTIME === 'true' || process.env.NODE_ENV === 'test') {
        return false;
    }

    const token = process.env.INFISICAL_TOKEN;
    const clientId = process.env.INFISICAL_CLIENT_ID;
    const clientSecret = process.env.INFISICAL_CLIENT_SECRET;
    const projectId = process.env.INFISICAL_PROJECT_ID;
    if ((!token && (!clientId || !clientSecret)) || !projectId) return false;

    try {
        const { InfisicalSDK } = await import('@infisical/sdk');
        const infisical = new InfisicalSDK({ siteUrl: process.env.INFISICAL_SITE_URL || 'https://app.infisical.com' });
        if (token) {
            infisical.auth().accessToken(token);
        } else {
            await infisical.auth().universalAuth.login({ clientId, clientSecret });
        }

        const response = await infisical.secrets().listSecrets({
            environment: mapNodeEnvToInfisicalEnv(process.env.NODE_ENV || 'dev'),
            projectId,
            secretPath: process.env.INFISICAL_SECRET_PATH || '/',
            includeImports: true
        });

        let loaded = 0;
        for (const secret of response?.secrets || []) {
            if (process.env[secret.secretKey] === undefined) {
                process.env[secret.secretKey] = sanitizeRuntimeValue(secret.secretValue);
                loaded += 1;
            }
        }
        return loaded > 0;
    } catch (error) {
        console.warn(`[runtime-env] Infisical runtime env load skipped: ${error?.message || error}`);
        return false;
    }
}

export async function hydrateEarlyRuntimeEnv({ requiredKeys = [], hydrateKeys = [] } = {}) {
    loadLocalRuntimeEnv();
    if (hasRequiredKeys(requiredKeys) && !hasMissingHydrationKeys(hydrateKeys)) {
        return { infisicalLoaded: false };
    }

    const infisicalLoaded = await loadInfisicalRuntimeEnv();
    return { infisicalLoaded };
}
