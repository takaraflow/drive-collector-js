export const D1_ACCOUNT_ID_ENV_KEYS = Object.freeze([
    "CLOUDFLARE_D1_ACCOUNT_ID",
    "CF_D1_ACCOUNT_ID",
    "CLOUDFLARE_ACCOUNT_ID",
    "CF_ACCOUNT_ID"
]);

export const D1_DATABASE_ID_ENV_KEYS = Object.freeze([
    "CLOUDFLARE_D1_DATABASE_ID",
    "CF_D1_DATABASE_ID"
]);

export const D1_TOKEN_ENV_KEYS = Object.freeze([
    "CLOUDFLARE_D1_TOKEN",
    "CF_D1_TOKEN"
]);

export const OSS_WORKER_URL_ENV_KEYS = Object.freeze([
    "OSS_WORKER_URL",
    "R2_WORKER_URL"
]);

export const OSS_WORKER_SECRET_ENV_KEYS = Object.freeze([
    "OSS_WORKER_SECRET",
    "R2_WORKER_AUTH_TOKEN"
]);

export function firstEnvValue(env, keys) {
    for (const key of keys) {
        const value = env[key];
        if (value !== undefined && value !== null && String(value).trim() !== "") {
            return value;
        }
    }
    return null;
}
