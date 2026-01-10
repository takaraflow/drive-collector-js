let manifestMetadataCache = null;
let manifestSensitiveConfigKeys = new Set();

function shouldRedactKey(key) {
    if (!key) return false;
    return manifestSensitiveConfigKeys.has(key);
}

function maskUrl(value) {
    try {
        const parsed = new URL(value);
        parsed.username = "";
        parsed.password = "";
        return parsed.toString();
    } catch {
        return value;
    }
}

function sanitizeEnvValue(name) {
    const raw = process.env[name];
    if (raw === undefined || raw === null) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    if (shouldRedactKey(name)) {
        return "[REDACTED]";
    }
    return trimmed;
}

async function loadManifestMetadata() {
    if (manifestMetadataCache) {
        return manifestMetadataCache;
    }

    manifestMetadataCache = { env: [] };
    manifestSensitiveConfigKeys = new Set();

    try {
        const module = await import("../../manifest.json", { assert: { type: "json" } });
        const manifest = module?.default || module;
        const envConfig = manifest?.config?.env || {};
        const entries = Object.entries(envConfig).sort(([aKey], [bKey]) => aKey.localeCompare(bKey));

        entries.forEach(([key, meta]) => {
            if (meta?.sensitive) {
                manifestSensitiveConfigKeys.add(key);
                const paths = Array.isArray(meta.configPaths) ? meta.configPaths : [];
                paths.forEach(configPath => {
                    const segments = String(configPath).split('.').filter(Boolean);
                    const keyName = segments[segments.length - 1];
                    if (keyName) manifestSensitiveConfigKeys.add(keyName);
                });
            }
        });

        const envList = entries.map(([key, meta]) => ({
            key,
            description: meta.description || null,
            required: meta.required === true,
            type: meta.type || null,
            defaultValue: meta.default ?? null,
            value: sanitizeEnvValue(key),
            sensitive: meta?.sensitive === true,
            configPaths: Array.isArray(meta?.configPaths) ? meta.configPaths : []
        }));

        manifestMetadataCache = {
            name: manifest?.name || null,
            version: manifest?.version || null,
            env: envList
        };
    } catch (error) {
        console.warn(`?? 无法加载 manifest.json: ${error.message}`);
        manifestMetadataCache = { env: [] };
    }

    return manifestMetadataCache;
}

function pruneConfig(value, key) {
    if (value === undefined || value === null) return undefined;

    if (Array.isArray(value)) {
        const items = value
            .map(item => pruneConfig(item))
            .filter(item => item !== undefined);
        return items.length ? items : undefined;
    }

    if (typeof value === "object") {
        const entries = Object.entries(value)
            .map(([childKey, childValue]) => [childKey, pruneConfig(childValue, childKey)])
            .filter(([, childValue]) => childValue !== undefined);

        if (!entries.length) return undefined;

        const cleaned = Object.fromEntries(entries);
        if (Object.keys(cleaned).length === 1 && cleaned.enabled === false) {
            return undefined;
        }
        return cleaned;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return undefined;
        if (shouldRedactKey(key)) {
            return "[REDACTED]";
        }
        if (key === "url") {
            return maskUrl(trimmed);
        }
        return trimmed;
    }

    return value;
}

export async function summarizeStartupConfig(config, cache) {
    const providers = (cache.providerList || [])
        .map(entry => {
            if (!entry?.config) return null;
            const { name, type, priority } = entry.config;
            return pruneConfig({ name, type, priority });
        })
        .filter(Boolean);

    const cacheSummary = pruneConfig({
        currentProvider: cache.getCurrentProvider(),
        providers: providers.length ? providers : undefined
    });

    const mergedConfig = {
        ...config,
        http2: config.http2?.enabled ? config.http2 : undefined,
        cache: cacheSummary
    };

    const runtimeInfo = pruneConfig({
        nodeEnv: process.env.NODE_ENV || "unknown",
        nodeMode: process.env.NODE_MODE || "unknown",
        telegramTestMode: config.telegram.testMode
    });

    const manifestMetadata = await loadManifestMetadata();
    const manifestSummary = pruneConfig({
        version: manifestMetadata.version,
        name: manifestMetadata.name,
        env: manifestMetadata.env
    });

    const configuration = pruneConfig(mergedConfig) || {};

    const summary = {
        runtime: runtimeInfo,
        configuration
    };

    if (manifestSummary) {
        summary.manifest = manifestSummary;
    }

    return summary;
}
