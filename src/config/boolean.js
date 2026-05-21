const TRUE_BOOLEAN_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_BOOLEAN_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

export function parseBoolean(value, fallback) {
    if (value === undefined || value === null || value === '') {
        return fallback;
    }
    if (typeof value === 'boolean') {
        return value;
    }

    const normalized = String(value).trim().toLowerCase();
    if (TRUE_BOOLEAN_VALUES.has(normalized)) {
        return true;
    }
    if (FALSE_BOOLEAN_VALUES.has(normalized)) {
        return false;
    }
    return fallback;
}
