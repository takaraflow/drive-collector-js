import { DriveRepository } from "../repositories/DriveRepository.js";
import { cache } from "./CacheService.js";
import { CloudTool } from "./rclone.js";
import { CACHE_KEYS } from "../domain/cache-keys.js";
import { logger } from "./logger/index.js";

const log = logger.withModule ? logger.withModule('DuplicateScanner') : logger;

// 单网盘扫描硬上限。lsjson -R 会一直占着 drive-session mutex(Proton),超时前该用户的
// 所有转存都在排队,所以宁可超时也不要长时间霸占。
const PER_DRIVE_TIMEOUT_MS = 120 * 1000;
const SCAN_STATE_TTL_SECONDS = 60 * 60; // 扫描中的状态;结果另用长 TTL

/**
 * 把 lsjson 条目按判重依据分组。
 *
 * 纯函数,不碰 rclone/Redis —— 这样"哈希为空时不能谎称无重复"这条规则能被单独测到。
 *
 * @param {Array} entries rclone lsjson 条目
 * @returns {{ groups: Array, hashed: number, total: number, hashAvailable: boolean }}
 */
export function groupDuplicates(entries) {
    const files = (entries || []).filter(e => e && !e.IsDir && Number(e.Size) > 0);

    const hashed = [];
    const unhashed = [];
    for (const file of files) {
        // rclone 的 Hashes 是 {算法名: 值};后端不支持时为空对象。
        const hashes = file.Hashes || {};
        const algo = Object.keys(hashes)[0];
        const value = algo ? hashes[algo] : null;
        if (value) hashed.push({ file, key: `${algo}:${value}` });
        else unhashed.push(file);
    }

    const groups = [];

    // 内容级判重:同一后端哈希算法下的相同值 = 内容相同
    const byHash = new Map();
    for (const item of hashed) {
        const list = byHash.get(item.key);
        if (list) list.push(item.file);
        else byHash.set(item.key, [item.file]);
    }
    for (const [key, list] of byHash) {
        if (list.length < 2) continue;
        groups.push({
            basis: 'hash',
            algo: key.split(':')[0],
            size: list[0].Size ?? 0,
            paths: list.map(f => f.Path || f.Name)
        });
    }

    // 降级:无哈希的文件只能按大小归组,必须标注"可能内容不同"
    const bySize = new Map();
    for (const file of unhashed) {
        const size = Number(file.Size) || 0;
        if (size <= 0) continue; // 空目录/0 字节不参与,否则全是噪音
        const list = bySize.get(size);
        if (list) list.push(file);
        else bySize.set(size, [file]);
    }
    for (const [size, list] of bySize) {
        if (list.length < 2) continue;
        groups.push({
            basis: 'size',
            algo: null,
            size,
            paths: list.map(f => f.Path || f.Name)
        });
    }

    // 大组在前:用户最想删的就是这批
    groups.sort((a, b) => (b.paths.length - a.paths.length) || (b.size - a.size));

    return {
        groups,
        hashed: hashed.length,
        total: files.length,
        // 没有任何哈希 => 无法做内容级判重。这个信号必须传出去,否则上层会误报"未发现重复"。
        hashAvailable: hashed.length > 0
    };
}

/**
 * 扫描单个网盘的重复文件(只读)。
 * @param {string} userId
 * @param {object} driveRow 目标网盘行;非默认网盘必须显式传入
 */
export async function scanDrive(userId, driveRow) {
    const conf = await CloudTool._getUserConfig(userId, driveRow);
    const runtime = await CloudTool._openUserRemoteRuntime(userId, conf, driveRow);
    try {
        const ret = await CloudTool._runRclone(
            ["lsjson", "-R", "--files-only", "--hash", runtime.connectionString],
            PER_DRIVE_TIMEOUT_MS,
            runtime.configArgs
        );

        if (ret.code !== 0) {
            const reason = ret.stderr === 'TIMEOUT'
                ? `扫描超时（超过 ${PER_DRIVE_TIMEOUT_MS / 1000} 秒）`
                : CloudTool.sanitizeRcloneOutput(ret.stderr || ret.error?.message || '未知错误');
            return { ok: false, reason };
        }

        let entries;
        try {
            entries = JSON.parse(ret.stdout || '[]');
        } catch {
            return { ok: false, reason: '无法解析 rclone 输出' };
        }
        if (!Array.isArray(entries)) entries = [];

        return { ok: true, result: groupDuplicates(entries) };
    } finally {
        // 必须放在 finally:漏了就是泄漏 tempDir + 永久持有 Proton session mutex。
        await runtime.dispose();
    }
}

/**
 * 按范围选出要扫的网盘。
 * @param {string} scope 'default' | 'all'
 */
export async function resolveDrives(userId, scope) {
    if (scope === 'default') {
        const drive = await DriveRepository.getDefaultDrive(userId);
        return drive ? [drive] : [];
    }
    const drives = await DriveRepository.findByUserId(userId);
    return Array.isArray(drives) ? drives : [];
}

/**
 * 扫描状态读写(Redis,跨实例/跨重启可见)。
 * 取消标志也放这里:按钮回调可能落在非 leader 实例上。
 */
export async function readScanState(userId) {
    try {
        return await cache.get(CACHE_KEYS.dupScan(userId), "json");
    } catch (e) {
        log.warn('Failed to read dup scan state', { userId, error: e.message });
        return null;
    }
}

export async function writeScanState(userId, patch) {
    const current = (await readScanState(userId)) || {};
    const next = { ...current, ...patch, updated_at: Date.now() };
    await cache.set(CACHE_KEYS.dupScan(userId), next, SCAN_STATE_TTL_SECONDS);
    return next;
}

export async function clearScanState(userId) {
    try {
        await cache.delete(CACHE_KEYS.dupScan(userId));
    } catch (e) {
        log.warn('Failed to clear dup scan state', { userId, error: e.message });
    }
}

/**
 * 请求取消。运行中的循环会在每个网盘之间检查这个标志。
 */
export async function requestCancel(userId) {
    const state = await readScanState(userId);
    if (!state || state.status !== 'running') return false;
    await writeScanState(userId, { cancelRequested: true });
    return true;
}
