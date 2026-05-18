import fs from 'fs';
import v8 from 'v8';

/**
 * 轻量级内存监控器
 * 在 256MB 容器中，Node.js 堆限制 200MB，需要主动监控内存压力
 */

const HEAP_WARNING_RATIO = 0.75;  // 75% 堆使用时警告
const HEAP_CRITICAL_RATIO = 0.90; // 90% 堆使用时紧急 GC
const MONITOR_INTERVAL_MS = 30_000; // 30秒检查一次
const BYTES_PER_MB = 1024 * 1024;
const MAX_REASONABLE_MEMORY_LIMIT_BYTES = 1024 ** 5; // Ignore host-level cgroup sentinels.

let monitorTimer = null;

export const formatMB = (bytes) => `${(bytes / BYTES_PER_MB).toFixed(1)}MB`;
const formatWholeMB = (bytes) => `${Math.round(bytes / BYTES_PER_MB)}MB`;
const formatRatio = (usedBytes, limitBytes) => `${Math.round((usedBytes / limitBytes) * 100)}%`;

const isUsableMemoryLimit = (bytes) => (
    Number.isFinite(bytes) &&
    bytes > 0 &&
    bytes < MAX_REASONABLE_MEMORY_LIMIT_BYTES
);

export const readContainerMemoryLimitBytes = (readFileSync = fs.readFileSync) => {
    const paths = [
        '/sys/fs/cgroup/memory.max',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes'
    ];

    for (const path of paths) {
        try {
            const raw = String(readFileSync(path, 'utf8')).trim();
            if (!raw || raw === 'max') continue;

            const limit = Number.parseInt(raw, 10);
            if (isUsableMemoryLimit(limit)) return limit;
        } catch {
            // Cgroup files differ by runtime; missing files are expected locally.
        }
    }

    return null;
};

export const getV8HeapLimitBytes = (heapStatistics = v8.getHeapStatistics()) => {
    const limit = Number(heapStatistics?.heap_size_limit);
    return isUsableMemoryLimit(limit) ? limit : null;
};

const formatDiagnosticCapacity = (usedBytes, limitBytes) => {
    if (isUsableMemoryLimit(limitBytes)) {
        return `${formatWholeMB(usedBytes)} / ${formatWholeMB(limitBytes)} (${formatRatio(usedBytes, limitBytes)})`;
    }

    return formatWholeMB(usedBytes);
};

export const getMemoryDiagnostics = ({
    memoryUsage = process.memoryUsage(),
    heapStatistics = v8.getHeapStatistics(),
    containerMemoryLimitBytes = readContainerMemoryLimitBytes()
} = {}) => {
    const heapLimitBytes = getV8HeapLimitBytes(heapStatistics);

    return {
        rss: formatDiagnosticCapacity(memoryUsage.rss, containerMemoryLimitBytes),
        heap: formatDiagnosticCapacity(memoryUsage.heapUsed, heapLimitBytes),
        external: formatWholeMB(memoryUsage.external || 0),
        raw: {
            rssBytes: memoryUsage.rss,
            heapUsedBytes: memoryUsage.heapUsed,
            heapTotalBytes: memoryUsage.heapTotal,
            heapLimitBytes,
            externalBytes: memoryUsage.external || 0,
            containerMemoryLimitBytes
        }
    };
};

/**
 * 检查当前内存状态并采取行动
 * 使用 console.warn 直接输出，避免循环依赖和异步问题
 */
export const checkMemoryPressure = () => {
    const mem = process.memoryUsage();
    const maxHeapMB = parseInt(
        (process.env.NODE_OPTIONS || '').match(/max-old-space-size=(\d+)/)?.[1] || '200',
        10
    );
    const maxHeap = maxHeapMB * 1024 * 1024;
    const heapRatio = mem.heapUsed / maxHeap;

    if (heapRatio >= HEAP_CRITICAL_RATIO) {
        // 紧急：尝试主动 GC
        if (global.gc) {
            global.gc();
            const afterMem = process.memoryUsage();
            const afterRatio = afterMem.heapUsed / maxHeap;
            console.warn(
                `🚨 内存紧急! 堆 ${formatMB(mem.heapUsed)}/${formatMB(maxHeap)} ` +
                `(${(heapRatio * 100).toFixed(0)}%), GC后 ${formatMB(afterMem.heapUsed)} ` +
                `(${(afterRatio * 100).toFixed(0)}%)`
            );
        } else {
            console.warn(
                `🚨 Memory critical! Heap ${formatMB(mem.heapUsed)}/${formatMB(maxHeap)} ` +
                `(${(heapRatio * 100).toFixed(0)}%). Add --expose-gc for emergency GC.`
            );
        }
    } else if (heapRatio >= HEAP_WARNING_RATIO) {
        console.warn(
            `⚠️ Memory pressure: Heap ${formatMB(mem.heapUsed)}/${formatMB(maxHeap)} ` +
            `(${(heapRatio * 100).toFixed(0)}%)`
        );
    }

    return { heapUsed: mem.heapUsed, maxHeap, heapRatio };
};

/**
 * 启动定期内存监控
 */
export const startMemoryMonitor = (intervalMs = MONITOR_INTERVAL_MS) => {
    if (monitorTimer) return;

    // 只在有 --max-old-space-size 配置时启用（容器环境）
    const nodeOptions = process.env.NODE_OPTIONS || '';
    if (!nodeOptions.includes('max-old-space-size')) {
        return;
    }

    monitorTimer = setInterval(() => {
        try {
            checkMemoryPressure();
        } catch {
            // 监控不应影响主流程
        }
    }, intervalMs);

    monitorTimer.unref(); // 不阻止进程退出
};

/**
 * 停止内存监控
 */
export const stopMemoryMonitor = () => {
    if (monitorTimer) {
        clearInterval(monitorTimer);
        monitorTimer = null;
    }
};

export default {
    checkMemoryPressure,
    formatMB,
    getMemoryDiagnostics,
    getV8HeapLimitBytes,
    readContainerMemoryLimitBytes,
    startMemoryMonitor,
    stopMemoryMonitor
};
