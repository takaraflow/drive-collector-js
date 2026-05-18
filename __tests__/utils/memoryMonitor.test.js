import {
    getMemoryDiagnostics,
    getV8HeapLimitBytes,
    readContainerMemoryLimitBytes
} from '../../src/utils/memoryMonitor.js';

describe('memoryMonitor diagnostics', () => {
    test('should render operator-focused memory capacity lines', () => {
        const diagnostics = getMemoryDiagnostics({
            memoryUsage: {
                rss: 122 * 1024 * 1024,
                heapUsed: 41 * 1024 * 1024,
                heapTotal: 44 * 1024 * 1024,
                external: 9 * 1024 * 1024
            },
            heapStatistics: {
                heap_size_limit: 200 * 1024 * 1024
            },
            containerMemoryLimitBytes: 256 * 1024 * 1024
        });

        expect(diagnostics).toMatchObject({
            rss: '122MB / 256MB (48%)',
            heap: '41MB / 200MB (21%)',
            external: '9MB'
        });
        expect(diagnostics.raw).toMatchObject({
            rssBytes: 122 * 1024 * 1024,
            heapUsedBytes: 41 * 1024 * 1024,
            heapTotalBytes: 44 * 1024 * 1024,
            heapLimitBytes: 200 * 1024 * 1024,
            externalBytes: 9 * 1024 * 1024,
            containerMemoryLimitBytes: 256 * 1024 * 1024
        });
    });

    test('should degrade gracefully when container limit is unavailable', () => {
        const diagnostics = getMemoryDiagnostics({
            memoryUsage: {
                rss: 122 * 1024 * 1024,
                heapUsed: 41 * 1024 * 1024,
                heapTotal: 44 * 1024 * 1024,
                external: 9 * 1024 * 1024
            },
            heapStatistics: {
                heap_size_limit: 200 * 1024 * 1024
            },
            containerMemoryLimitBytes: null
        });

        expect(diagnostics.rss).toBe('122MB');
        expect(diagnostics.heap).toBe('41MB / 200MB (21%)');
        expect(diagnostics.external).toBe('9MB');
    });

    test('should ignore unlimited cgroup sentinel values', () => {
        const readFileSync = vi
            .fn()
            .mockReturnValueOnce('max')
            .mockReturnValueOnce(`${2 ** 63 - 4096}`);

        expect(readContainerMemoryLimitBytes(readFileSync)).toBeNull();
    });

    test('should return V8 heap limit from heap statistics', () => {
        expect(getV8HeapLimitBytes({
            heap_size_limit: 200 * 1024 * 1024
        })).toBe(200 * 1024 * 1024);
    });
});
