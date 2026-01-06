/**
 * configParser.js
 * 
 * Utility to parse JSON configuration strings and interpolate environment variables.
 * Supports recursive replacement of ${VAR_NAME} placeholders.
 */

/**
 * Recursively traverses an object or array and replaces string values 
 * containing ${VAR} with process.env[VAR].
 * 
 * @param {any} value - The value to process
 * @returns {any} - The processed value
 */
function interpolateEnv(value) {
    if (typeof value === 'string') {
        // Match ${VAR_NAME} pattern
        const match = value.match(/^\$\{([A-Z0-9_]+)\}$/);
        if (match) {
            const envVar = match[1];
            const envValue = process.env[envVar];
            if (envValue === undefined) {
                console.warn(`[ConfigParser] Missing environment variable: ${envVar}`);
                return ''; // Return empty string if missing
            }
            return envValue;
        }
        return value; // Return original string if no placeholder
    }

    if (Array.isArray(value)) {
        return value.map(item => interpolateEnv(item));
    }

    if (value !== null && typeof value === 'object') {
        const result = {};
        for (const key in value) {
            result[key] = interpolateEnv(value[key]);
        }
        return result;
    }

    return value;
}

/**
 * Parses a JSON string and interpolates environment variables.
 * 
 * @param {string} jsonString - The JSON string to parse
 * @returns {object|object[]} - The parsed and interpolated configuration
 * @throws {Error} - If JSON parsing fails
 */
function parseCacheConfig(jsonString) {
    if (!jsonString) return null;

    try {
        const rawConfig = JSON.parse(jsonString);
        return interpolateEnv(rawConfig);
    } catch (error) {
        console.error(`[ConfigParser] Failed to parse JSON configuration: ${error.message}`);
        return null;
    }
}

export { parseCacheConfig, interpolateEnv };