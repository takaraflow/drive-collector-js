import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { FileCache } from '../../../src/services/cache/FileCache.js';

describe('FileCache', () => {
    let cacheDir;
    let cache;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-17T00:00:00.000Z'));
        cacheDir = await mkdtemp(path.join(os.tmpdir(), 'drive-collector-file-cache-'));
        cache = new FileCache({ basePath: cacheDir, ttl: 60 });
        await cache.connect();
    });

    afterEach(async () => {
        await cache?.disconnect();
        await rm(cacheDir, { recursive: true, force: true });
        vi.useRealTimers();
    });

    test('should persist json values and list live keys by prefix', async () => {
        await cache.set('task:1', { state: 'queued' }, 60);
        await cache.set('drive:1', { name: 'primary' }, 60);

        await expect(cache.get('task:1')).resolves.toEqual({ state: 'queued' });
        await expect(cache.listKeys('task:')).resolves.toEqual(['task:1']);
    });

    test('should return text and buffer values in requested format', async () => {
        await cache.set('plain', 'hello', 60);
        await cache.set('bytes', Buffer.from('payload'), 60);

        await expect(cache.get('plain', 'text')).resolves.toBe('hello');
        await expect(cache.get('bytes', 'buffer')).resolves.toEqual(Buffer.from('payload'));
    });

    test('should expire stale entries and remove them from listings', async () => {
        await cache.set('task:stale', { state: 'done' }, 5);

        vi.advanceTimersByTime(6000);

        await expect(cache.get('task:stale')).resolves.toBeNull();
        await expect(cache.listKeys('task:')).resolves.toEqual([]);
    });
});
