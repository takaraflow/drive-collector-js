export const DRIVE_CONFIG_SCHEMA_VERSION = 1;

export const RCLONE_PASSWORD_FORMATS = Object.freeze({
    PLAIN: "plain",
    RCLONE_OBSCURED: "rclone_obscured",
    LEGACY_UNKNOWN: "legacy_unknown"
});

export const RCLONE_OBSCURED_PASSWORD_DRIVE_TYPES = Object.freeze(["mega", "pikpak", "webdav"]);

const VALID_RCLONE_PASSWORD_FORMATS = new Set(Object.values(RCLONE_PASSWORD_FORMATS));

export function normalizePasswordFormat(format) {
    if (format === undefined || format === null || format === "") return null;
    const normalized = String(format).trim().toLowerCase();
    return VALID_RCLONE_PASSWORD_FORMATS.has(normalized) ? normalized : null;
}

export function hasPasswordCredential(config = {}) {
    return config.pass !== undefined && config.pass !== null && String(config.pass) !== "";
}

export function markRclonePasswordConfig(config = {}, pass) {
    return {
        ...config,
        pass,
        pass_format: RCLONE_PASSWORD_FORMATS.RCLONE_OBSCURED,
        config_schema_version: DRIVE_CONFIG_SCHEMA_VERSION
    };
}

export function markLegacyUnknownRclonePasswordConfig(config = {}) {
    return {
        ...config,
        pass_format: RCLONE_PASSWORD_FORMATS.LEGACY_UNKNOWN,
        config_schema_version: DRIVE_CONFIG_SCHEMA_VERSION
    };
}

export function hasExplicitRclonePasswordFormat(config = {}) {
    return Boolean(normalizePasswordFormat(config.pass_format)) &&
        Number(config.config_schema_version) === DRIVE_CONFIG_SCHEMA_VERSION;
}

export function isCanonicalRclonePasswordConfig(config = {}) {
    return normalizePasswordFormat(config.pass_format) === RCLONE_PASSWORD_FORMATS.RCLONE_OBSCURED &&
        Number(config.config_schema_version) === DRIVE_CONFIG_SCHEMA_VERSION;
}

export function requiresRcloneObscuredPassword(driveType) {
    return RCLONE_OBSCURED_PASSWORD_DRIVE_TYPES.includes(String(driveType || "").toLowerCase());
}
