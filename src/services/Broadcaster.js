/**
 * Broadcaster - Redis pub/sub 实例间广播
 *
 * 职责铁律:这里只承载"丢了也无害的通知"。权威数据永远在 D1/Redis 缓存 + TTL 里,
 * pub/sub 通知只决定"什么时候去刷新",订阅者离线窗口内的消息永久丢失是设计预期。
 * 凡正确性依赖的消息必须走 QStash 任务队列,禁止往这里塞。
 *
 * 连接复用 CacheService 已连接的 provider:直接 client.duplicate() 克隆其 url/TLS/auth/重试
 * 策略,不重复解析环境变量。pub/sub 连接进入订阅态后不能执行普通命令,故 publisher/subscriber
 * 是两条独立连接。若主 provider 不是 ioredis(HTTP/内存缓存),pub/sub 不可用则降级为 no-op——
 * 通知丢失由 TTL 兜底,正确性不受影响。
 */
import { logger } from "./logger/index.js";
import { cache } from "./CacheService.js";

const log = logger.withModule?.('Broadcaster') || logger;

export const CHANNELS = {
    stateChanged: 'dc:state:changed',
    cacheInvalidate: 'dc:cache:invalidate',
    batchEvents: 'dc:batch:events'
};

export class Broadcaster {
    constructor() {
        this.publisher = null;
        this.subscriber = null;
        this.handlers = new Map(); // channel -> Set<fn>
        this.starting = null;
        this._messageWired = false;
        this._warnedUnavailable = false; // 日志节流:provider 无 ioredis 时只告警一次,不永久锁死(可自愈)
        this._stopped = false;           // stop() 后置位:防止停机后残留的 publish 又把连接拉起来(幽灵连接)
    }

    _makeConnection(role) {
        // subscriber 进入订阅态后只收发订阅命令,禁掉请求级重试防止命令永久挂起
        const conn = cache.duplicateClient(role === 'subscriber' ? { maxRetriesPerRequest: null } : {});
        // 非 ioredis provider(HTTP/内存)拿不到可复制的连接,pub/sub 不可用
        if (!conn) return null;
        conn.on('error', (e) => log.warn(`Broadcaster ${role} error:`, e?.message || e));
        return conn;
    }

    async _ensure() {
        if (this._stopped) return false;
        if (this.publisher?.status === 'ready' && this.subscriber?.status === 'ready') return true;
        if (!this.starting) {
            this.starting = (async () => {
                // 注:连接从主 cache provider 克隆一次并复用整个进程生命周期;不跟随 cache 故障切换。
                // provider 若切到新端点,这里仍连旧端点直到进程重启——正确性由 TTL 兜底(通知丢失无害)。
                const pub = this.publisher || this._makeConnection('publisher');
                const sub = this.subscriber || this._makeConnection('subscriber');
                if (!pub || !sub) {
                    // 主 provider 暂无 ioredis 客户端(如全部 provider 失败降级到 MemoryCache):
                    // 本轮不可用,但不永久锁死——provider 恢复后下次调用重试(自愈)。日志只警告一次防刷屏。
                    if (!this._warnedUnavailable) {
                        this._warnedUnavailable = true;
                        log.warn('Broadcaster 暂不可用:主缓存 provider 无 ioredis 客户端,pub/sub 本轮跳过(通知由 TTL 兜底,provider 恢复后自愈)');
                    }
                    return; // 保持 publisher/subscriber 原值(null),下次重试
                }
                this.publisher = pub;
                this.subscriber = sub;
                this._warnedUnavailable = false; // 恢复了,允许下次故障再次告警
                if (!this._messageWired) {
                    this.subscriber.on('ready', () => this._resubscribe()); // 断线重连成功后自动恢复订阅
                    this._wireMessages();
                }
                await Promise.all([this._connect(this.publisher), this._connect(this.subscriber)]);
            })().finally(() => { this.starting = null; });
        }
        await this.starting;
        return !this._stopped && !!this.publisher && !!this.subscriber;
    }

    async _connect(conn) {
        // provider 客户端 lazyConnect,克隆出来同样是 wait 态,首次需显式连接;已在连接/就绪则忽略
        if (conn.status === 'ready') return;
        try { await conn.connect(); } catch { /* 已在连接中或首命令会触发,忽略 */ }
    }

    _wireMessages() {
        if (this._messageWired) return;
        this._messageWired = true;
        this.subscriber.on('message', (channel, raw) => {
            const handlers = this.handlers.get(channel);
            if (!handlers || !handlers.size) return;
            let payload;
            try { payload = JSON.parse(raw); } catch { return; }
            for (const handler of handlers) {
                Promise.resolve(handler(payload)).catch((e) => log.error('Broadcast handler failed:', e?.message || e));
            }
        });
    }

    async _resubscribe() {
        if (!this.subscriber) return;
        for (const channel of this.handlers.keys()) {
            try {
                await this.subscriber.subscribe(channel);
            } catch (e) {
                log.warn('Resubscribe failed', { channel, error: e?.message || e });
            }
        }
    }

    async publish(channel, payload) {
        try {
            if (!(await this._ensure())) return;
            await this.publisher.publish(channel, JSON.stringify(payload));
        } catch (e) {
            // 通知丢失是设计预期,警告即可,绝不向上抛
            log.warn('Broadcast publish dropped (notification loss is by design)', { channel, error: e?.message || e });
        }
    }

    async subscribe(channel, handler) {
        if (!this.handlers.has(channel)) this.handlers.set(channel, new Set());
        this.handlers.get(channel).add(handler);
        try {
            // handler 已登记:即使此刻 provider 无 ioredis,将来恢复后 _resubscribe 会兜底
            if (!(await this._ensure())) return;
            await this.subscriber.subscribe(channel);
        } catch (e) {
            log.warn('Broadcast subscribe failed', { channel, error: e?.message || e });
        }
    }

    async stop() {
        this._stopped = true;
        this.handlers.clear();
        this._messageWired = false;
        try { await this.subscriber?.quit(); } catch { /* ignore */ }
        try { await this.publisher?.quit(); } catch { /* ignore */ }
        this.subscriber = null;
        this.publisher = null;
    }
}

export const broadcaster = new Broadcaster();
