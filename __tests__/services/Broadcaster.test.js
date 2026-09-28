import { describe, beforeEach, afterEach, test, expect, vi } from 'vitest';

// 用一个可控的 fake ioredis 客户端替身:duplicate() 返回可注入行为的连接。
// 目的:锁住 Broadcaster 三条载重不变量——publish 永不 reject、无 ioredis 时降级 no-op、坏 JSON 不崩。
function makeFakeClient({ failPublish = false } = {}) {
    const handlers = {};
    const conn = {
        status: 'wait',
        subscribedChannels: [],
        on: vi.fn((ev, fn) => { (handlers[ev] ||= []).push(fn); return conn; }),
        emit: (ev, ...args) => (handlers[ev] || []).forEach(fn => fn(...args)),
        connect: vi.fn(async () => { conn.status = 'ready'; }),
        subscribe: vi.fn(async (ch) => { conn.subscribedChannels.push(ch); }),
        publish: vi.fn(async () => { if (failPublish) throw new Error('publish blew up'); return 1; }),
        quit: vi.fn(async () => { conn.status = 'end'; })
    };
    return conn;
}

let duplicateImpl;
vi.mock('../../src/services/CacheService.js', () => ({
    cache: {
        // Broadcaster 只通过这个方法拿连接;测试按需切换其行为
        duplicateClient: (...args) => duplicateImpl(...args)
    }
}));

vi.mock('../../src/services/logger/index.js', () => ({
    logger: { withModule: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
}));

import { Broadcaster } from '../../src/services/Broadcaster.js';

describe('Broadcaster - pub/sub 载重不变量', () => {
    let b;

    afterEach(async () => {
        if (b) await b.stop();
        b = null;
    });

    test('publish 在底层 client.publish 抛错时也永不 reject(通知丢失是设计预期)', async () => {
        duplicateImpl = () => makeFakeClient({ failPublish: true });
        b = new Broadcaster();

        await expect(b.publish('dc:test', { a: 1 })).resolves.toBeUndefined();
    });

    test('主 provider 无 ioredis 客户端时,publish/subscribe 降级为 no-op 且不抛', async () => {
        duplicateImpl = () => null; // 模拟 HTTP/内存 provider
        b = new Broadcaster();

        const handler = vi.fn();
        await expect(b.subscribe('dc:test', handler)).resolves.toBeUndefined();
        await expect(b.publish('dc:test', { a: 1 })).resolves.toBeUndefined();
        expect(handler).not.toHaveBeenCalled();
    });

    test('subscribe 后:合法消息投递给 handler,坏 JSON 被吞不崩', async () => {
        const sub = makeFakeClient();
        const pub = makeFakeClient();
        duplicateImpl = (overrides) => (overrides && overrides.maxRetriesPerRequest === null ? sub : pub);
        b = new Broadcaster();

        const handler = vi.fn();
        await b.subscribe('dc:test', handler);
        expect(sub.subscribe).toHaveBeenCalledWith('dc:test');

        // 坏 JSON:不得抛,也不得调用 handler
        expect(() => sub.emit('message', 'dc:test', '{bad json')).not.toThrow();
        expect(handler).not.toHaveBeenCalled();

        // 合法消息:解析后交给 handler
        sub.emit('message', 'dc:test', JSON.stringify({ hello: 'world' }));
        await Promise.resolve();
        expect(handler).toHaveBeenCalledWith({ hello: 'world' });
    });

    test('stop() 后 publish 不再拉起连接(防幽灵连接)', async () => {
        const pub = makeFakeClient();
        const sub = makeFakeClient();
        let made = 0;
        duplicateImpl = (overrides) => { made++; return overrides && overrides.maxRetriesPerRequest === null ? sub : pub; };
        b = new Broadcaster();

        await b.publish('dc:test', { a: 1 }); // 建连一次
        const madeAfterFirst = made;
        await b.stop();

        await b.publish('dc:test', { a: 2 }); // stop 后不得再建连
        expect(made).toBe(madeAfterFirst);
    });
});
