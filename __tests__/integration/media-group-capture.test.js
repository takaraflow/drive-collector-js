import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Api, utils } from 'telegram';
import { getMessages, iterMessages } from 'telegram/client/messages.js';
import bigInt from 'big-integer';
import mediaGroupBuffer, { MediaGroupBuffer } from '../../src/services/MediaGroupBuffer.js';
import { STRINGS, format } from '../../src/locales/zh-CN.js';
import { getMediaInfo } from '../../src/utils/common.js';

const { sourceRoot, mocks } = await vi.hoisted(async () => {
    const { fileURLToPath } = await import('node:url');
    vi.useFakeTimers();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return {
        sourceRoot: fileURLToPath(new URL('../../src/', import.meta.url)),
        mocks: {
            log,
            logger: { withModule: vi.fn(() => log) },
            cache: { get: vi.fn(), set: vi.fn(), delete: vi.fn(), compareAndSet: vi.fn() },
            client: { getMessages: vi.fn(), sendMessage: vi.fn(), editMessage: vi.fn() },
            taskRepository: { createBatch: vi.fn() },
            queue: { enqueueDownloadTask: vi.fn() },
            deps: {},
            nextId: 0
        }
    };
});

vi.mock(`${sourceRoot}services/logger/index.js`, () => ({ logger: mocks.logger }));
vi.mock(`${sourceRoot}services/CacheService.js`, () => ({ cache: mocks.cache }));
vi.mock(`${sourceRoot}services/telegram.js`, () => ({ client: mocks.client }));
vi.mock(`${sourceRoot}config/runtime.js`, () => ({
    getRuntimeInstanceId: () => 'album-test',
    isRuntimeTestEnv: () => true
}));
vi.mock(`${sourceRoot}services/DependencyContainer.js`, () => ({
    dependencyContainer: { get: name => mocks.deps[name], getAll: () => mocks.deps }
}));
vi.mock(`${sourceRoot}utils/limiter.js`, () => ({
    runMtprotoTask: fn => fn(),
    runBotTaskWithRetry: fn => fn()
}));
vi.mock(`${sourceRoot}services/DistributedLock.js`, () => ({
    DistributedLock: class {
        async acquire() { return { success: true, version: 'v1' }; }
        async getLockStatus() { return { status: 'held', owner: 'album-test', version: 'v1' }; }
        async release() { return true; }
    }
}));
vi.mock('crypto', async importOriginal => {
    const original = await importOriginal();
    const randomUUID = () => `album-task-${++mocks.nextId}`;
    return { ...original, randomUUID, default: { ...original.default, randomUUID } };
});

describe('Media group capture through GramJS', () => {
    let buffer;
    let store;
    let messages;
    let sdkClient;
    const userId = '500';
    const target = new Api.PeerUser({ userId: bigInt(userId) });

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-06T12:00:00Z'));
        vi.clearAllMocks();
        mediaGroupBuffer.stopCleanup();
        mediaGroupBuffer.cleanup();
        mocks.nextId = 0;
        store = new Map();
        const clone = value => value == null ? null : JSON.parse(JSON.stringify(value));
        mocks.cache.get.mockImplementation(async key => clone(store.get(key)));
        mocks.cache.set.mockImplementation(async (key, value) => {
            store.set(key, clone(value));
            return true;
        });
        mocks.cache.delete.mockImplementation(async key => store.delete(key));
        mocks.cache.compareAndSet.mockImplementation(async (key, value, options) => {
            const current = store.get(key) ?? null;
            if (options.ifNotExists && current !== null) return false;
            if ('ifEquals' in options && JSON.stringify(current) !== JSON.stringify(options.ifEquals)) return false;
            store.set(key, clone(value));
            return true;
        });
        mocks.client.sendMessage.mockResolvedValue({ id: 2000 });
        mocks.client.editMessage.mockResolvedValue({ id: 2000 });
        mocks.taskRepository.createBatch.mockResolvedValue(true);
        mocks.queue.enqueueDownloadTask.mockResolvedValue({ success: true });
        Object.assign(mocks.deps, {
            logger: mocks.logger,
            client: mocks.client,
            TaskRepository: mocks.taskRepository,
            queueService: mocks.queue,
            getMediaInfo,
            STRINGS,
            format,
            PRIORITY: { UI: 0 },
            runBotTaskWithRetry: fn => fn()
        });
        messages = [
            new Api.Message({
                id: 1001,
                peerId: target,
                date: 1788696000,
                message: '一张图片和一个视频',
                groupedId: bigInt('9999'),
                media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: bigInt(10) }) })
            }),
            new Api.Message({
                id: 1002,
                peerId: target,
                date: 1788696000,
                message: '',
                groupedId: bigInt('9999'),
                media: new Api.MessageMediaDocument({
                    document: new Api.Document({
                        id: bigInt(11), accessHash: bigInt(12), fileReference: Buffer.alloc(0),
                        date: 1788696000, mimeType: 'video/mp4', size: bigInt(1024), dcId: 1,
                        attributes: [new Api.DocumentAttributeFilename({ fileName: 'video.mp4' })]
                    })
                })
            })
        ];
        sdkClient = {
            _entityCache: new Map(),
            getInputEntity: vi.fn(async () => new Api.InputPeerUser({ userId: bigInt(userId), accessHash: bigInt(1) })),
            getPeerId: async peer => utils.getPeerId(peer),
            iterMessages: (entity, params) => iterMessages(sdkClient, entity, params),
            // Keep the SDK's real parameter conversion and wire serialization.
            // Only the network response is replaced by an in-memory Telegram fixture.
            invoke: vi.fn(async request => {
                await request.resolve(sdkClient, utils);
                request.getBytes();
                return new Api.messages.Messages({ messages, users: [], chats: [] });
            })
        };
        mocks.client.getMessages.mockImplementation((entity, params) => getMessages(sdkClient, entity, params));
        buffer = new MediaGroupBuffer({
            instanceId: 'album-test',
            bufferTimeout: 100,
            maxBatchSize: 10,
            useLocalTimers: true,
            remoteFlushEnabled: false
        });
    });

    afterEach(() => {
        buffer?.stopCleanup();
        buffer?.cleanup();
        mediaGroupBuffer.stopCleanup();
        mediaGroupBuffer.cleanup();
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    test.each(['local timer', 'remote event', 'batch limit'])(
        'should acknowledge a captioned photo and video album through %s and enqueue both files',
        async trigger => {
            if (trigger === 'batch limit') buffer.options.maxBatchSize = 2;
            if (trigger === 'remote event') buffer.options.useLocalTimers = false;
            for (const message of messages) {
                await buffer.add(message, target, userId);
            }
            await vi.advanceTimersByTimeAsync(120);
            if (trigger === 'remote event') await buffer.handleFlushEvent({ gid: '9999' });

            const errors = mocks.log.error.mock.calls.map(args => args.map(arg => arg?.message ?? String(arg)).join(' '));
            expect(mocks.client.sendMessage, errors.join('\n')).toHaveBeenCalledTimes(1);
            expect(mocks.client.sendMessage).toHaveBeenCalledWith(target, {
                message: format(STRINGS.task.batch_captured, { count: 2 }),
                parseMode: 'html'
            });
            expect(mocks.taskRepository.createBatch).toHaveBeenCalledWith([
                expect.objectContaining({ sourceMsgId: 1001, userId }),
                expect.objectContaining({ sourceMsgId: 1002, userId })
            ]);
            expect(mocks.queue.enqueueDownloadTask).toHaveBeenCalledTimes(2);
            expect(store.has('media_group_buffer:buffer:9999')).toBe(false);
            expect(mocks.log.error).not.toHaveBeenCalled();
        }
    );

    test('should acknowledge a full ten-item album once without waiting for a timer', async () => {
        messages = Array.from({ length: 10 }, (_, index) => new Api.Message({
            id: 1001 + index,
            peerId: target,
            date: 1788696000,
            message: index === 0 ? '十张照片' : '',
            groupedId: bigInt('9999'),
            media: new Api.MessageMediaPhoto({ photo: new Api.PhotoEmpty({ id: bigInt(10 + index) }) })
        }));
        for (const message of messages) {
            await buffer.add(message, target, userId);
        }

        expect(mocks.client.sendMessage).toHaveBeenCalledTimes(1);
        expect(mocks.client.sendMessage).toHaveBeenCalledWith(target, {
            message: format(STRINGS.task.batch_captured, { count: 10 }),
            parseMode: 'html'
        });
        expect(mocks.queue.enqueueDownloadTask).toHaveBeenCalledTimes(10);
        await vi.advanceTimersByTimeAsync(1000);
        expect(mocks.client.sendMessage).toHaveBeenCalledTimes(1);
    });
});
