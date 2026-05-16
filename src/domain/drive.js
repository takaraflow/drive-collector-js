export const DRIVE_STATUSES = Object.freeze({
    ACTIVE: "active",
    DELETED: "deleted"
});

export const DRIVE_COLUMNS = "id, user_id, name, type, config_data, remote_folder, status, is_default, created_at";

export function isDefaultDrive(drive) {
    return Number(drive?.is_default) === 1 || drive?.is_default === true;
}
