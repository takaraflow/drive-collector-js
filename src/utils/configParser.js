/**
 * Recursively traverses an object or array and replaces string values
 * containing ${VAR} with process.env[VAR] or env[VAR].
 *
 * @param {any} value - The value to process
 * @param {Object} env - Environment variables object
 * @returns {any} - The processed value
 */
function interpolateEnv(value, env = process.env) {
    if (typeof value === 'string') {
        const match = value.match(/^\$\{([A-Z0-9_]+)\}$/);
        if (match) {
            const envVar = match[1];
            const envValue = env[envVar];
            if (envValue === undefined) {
                console.warn(`[ConfigParser] Missing environment variable: ${envVar}`);
                return '';
            }
            return envValue;
        }
        return value;
    }

    if (Array.isArray(value)) {
        return value.map(item => interpolateEnv(item, env));
    }

    if (value !== null && typeof value === 'object') {
        const result = {};
        for (const key in value) {
            result[key] = interpolateEnv(value[key], env);
        }
        return result;
    }

    return value;
}

/**
 * Parses a JSON string and interpolates environment variables.
 *
 * @param {string} jsonString - The JSON string to parse
 * @param {Object} env - Environment variables object (optional, defaults to process.env)
 * @returns {object|object[]} - The parsed and interpolated configuration
 * @throws {Error} - If JSON parsing fails
 */
function parseCacheConfig(jsonString, env = process.env) {
    if (!jsonString) return null;

    try {
        const rawConfig = JSON.parse(jsonString);
        return interpolateEnv(rawConfig, env);
    } catch (error) {
        console.error(`[ConfigParser] Failed to parse JSON configuration: ${error.message}`);
        return null;
    }
}

export { parseCacheConfig, interpolateEnv };
