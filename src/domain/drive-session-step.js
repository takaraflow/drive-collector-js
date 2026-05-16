const STEP_SEPARATOR = ":";

export function encodeDriveSessionStep(driveType, step) {
    if (!driveType || !step) {
        throw new Error("Drive session step requires driveType and step.");
    }
    return `${String(driveType).toUpperCase()}${STEP_SEPARATOR}${step}`;
}

export function decodeDriveSessionStep(value, supportedTypes = []) {
    if (!value || typeof value !== "string") return null;

    if (value.includes(STEP_SEPARATOR)) {
        const [rawType, ...stepParts] = value.split(STEP_SEPARATOR);
        const step = stepParts.join(STEP_SEPARATOR);
        if (!rawType || !step) return null;
        return { driveType: rawType.toLowerCase(), step };
    }

    const orderedTypes = [...supportedTypes].sort((a, b) => String(b).length - String(a).length);
    for (const type of orderedTypes) {
        const prefix = `${String(type).toUpperCase()}_`;
        if (value.toUpperCase().startsWith(prefix)) {
            return {
                driveType: String(type).toLowerCase(),
                step: value.slice(prefix.length)
            };
        }
    }

    return null;
}

export function parseDriveSessionData(session) {
    const rawData = session?.temp_data;
    if (!rawData) return {};
    if (typeof rawData === "object") return rawData;
    try {
        return JSON.parse(rawData);
    } catch {
        return {};
    }
}

export function serializeDriveSessionData(data = {}) {
    return JSON.stringify(data || {});
}
