import fs from "fs";
import path from "path";

const DEFAULT_REQUIRED_HEADROOM_RATIO = 0.1;
const DEFAULT_REQUIRED_HEADROOM_BYTES = 256 * 1024 * 1024;

export class InsufficientStorageError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = "InsufficientStorageError";
        this.code = "INSUFFICIENT_STORAGE";
        this.details = details;
    }
}

export function resolveStorageGuardConfig(config = {}, env = process.env) {
    const localStorage = config.localStorage || {};
    const ratio = parseNumber(
        localStorage.requiredHeadroomRatio ?? env.LOCAL_STORAGE_REQUIRED_HEADROOM_RATIO,
        DEFAULT_REQUIRED_HEADROOM_RATIO
    );
    const bytes = parseNumber(
        localStorage.requiredHeadroomBytes ?? env.LOCAL_STORAGE_REQUIRED_HEADROOM_BYTES,
        DEFAULT_REQUIRED_HEADROOM_BYTES
    );

    return {
        requiredHeadroomRatio: clamp(ratio, 0, 1),
        requiredHeadroomBytes: Math.max(0, bytes)
    };
}

export async function ensureDirectoryWritable(dirPath, fsImpl = fs) {
    if (!dirPath) {
        throw new InsufficientStorageError("Storage directory is not configured", { dirPath });
    }

    await fsImpl.promises.mkdir(dirPath, { recursive: true });
    await fsImpl.promises.access(dirPath, fsImpl.constants.W_OK);
}

export async function getAvailableStorageBytes(dirPath, fsImpl = fs) {
    if (typeof fsImpl.promises?.statfs !== "function") {
        return null;
    }

    const stats = await fsImpl.promises.statfs(dirPath);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const availableBlocks = Number(stats.bavail ?? stats.bfree ?? 0);
    if (!Number.isFinite(blockSize) || !Number.isFinite(availableBlocks) || blockSize <= 0 || availableBlocks < 0) {
        return null;
    }

    return blockSize * availableBlocks;
}

export function getRequiredStorageBytes(expectedBytes, options = {}) {
    const normalizedExpected = Math.max(0, Number(expectedBytes || 0));
    const ratio = Number.isFinite(options.requiredHeadroomRatio)
        ? options.requiredHeadroomRatio
        : DEFAULT_REQUIRED_HEADROOM_RATIO;
    const headroomBytes = Number.isFinite(options.requiredHeadroomBytes)
        ? options.requiredHeadroomBytes
        : DEFAULT_REQUIRED_HEADROOM_BYTES;

    return Math.ceil(normalizedExpected * (1 + Math.max(0, ratio)) + Math.max(0, headroomBytes));
}

export async function assertLocalStorageCapacity({
    dirPath,
    expectedBytes,
    config = {},
    purpose = "local file staging",
    fsImpl = fs
}) {
    if (!dirPath) {
        throw new InsufficientStorageError("Storage directory is not configured", { dirPath, purpose });
    }

    const resolvedDir = path.resolve(dirPath);
    await ensureDirectoryWritable(resolvedDir, fsImpl);

    const guardConfig = resolveStorageGuardConfig(config);
    const availableBytes = await getAvailableStorageBytes(resolvedDir, fsImpl);
    const requiredBytes = getRequiredStorageBytes(expectedBytes, guardConfig);

    if (availableBytes !== null && availableBytes < requiredBytes) {
        throw new InsufficientStorageError(
            `Insufficient local storage for ${purpose}: available=${availableBytes}, required=${requiredBytes}`,
            {
                dirPath: resolvedDir,
                expectedBytes: Math.max(0, Number(expectedBytes || 0)),
                availableBytes,
                requiredBytes,
                purpose,
                ...guardConfig
            }
        );
    }

    return {
        dirPath: resolvedDir,
        expectedBytes: Math.max(0, Number(expectedBytes || 0)),
        availableBytes,
        requiredBytes,
        purpose,
        ...guardConfig
    };
}

function parseNumber(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
