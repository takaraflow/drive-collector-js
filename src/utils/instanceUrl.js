export function normalizePublicUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    try {
        return new URL(trimmed).toString().replace(/\/$/, '');
    } catch {
        return null;
    }
}

export function resolveInstanceBaseUrl(instance) {
    if (!instance || typeof instance !== 'object') return null;
    return normalizePublicUrl(instance.directUrl)
        || normalizePublicUrl(instance.tunnelUrl)
        || normalizePublicUrl(instance.url);
}
