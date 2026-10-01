/**
 * 影子比对(Node 侧记录)。
 *
 * 和 Go 影子客户端并行跑,记录同一套指纹到 Redis,供 Go 侧 diff。
 *
 * 边界:这是只读的旁路 —— 记录发生在 MessageHandler 之前,不参与任何
 * 业务判断,不吞消息,不延迟处理。记录失败只打日志,绝不抛。
 */
import { cache } from "../services/CacheService.js";
import { computeFingerprint, extractTypeId } from "../domain/shadow-fingerprint.js";
import { logger } from "../services/logger/index.js";

const log = logger.withModule ? logger.withModule('ShadowRecorder') : logger;

/**
 * 记录窗口内各类指纹的出现次数。
 *
 * 用计数而不是原始序列:影子验证要回答的是「两边看到的构成是否一致」,
 * 不是「顺序是否一致」。而且原始序列要落用户消息的元数据,那是隐私负担。
 */
const WINDOW_SECONDS = 15 * 60; // 15 分钟,单位是【秒】
const KEY = 'shadow:counts';

let enabled = false;
let flushTimer = null;
/** in-flight 守卫:Redis 卡住时,第二次 flush 不能和第一次交叉。 */
let flushing = false;

/** 内存里累计,按窗口落 Redis。 */
const counts = new Map();

function enabledByEnv() {
    if (process.env.SHADOW_RECORD !== 'true') return false;
    // 测试环境绝不写 Redis
    if (process.env.NODE_ENV === 'test') return false;
    return true;
}

/**
 * 从一条 update 提取可观察特征。
 *
 * 按类型分派而不是 duck typing —— gramjs 有一批 update 的 `message`
 * 字段就是【字符串】(updateShortMessage / updateShortChatMessage /
 * updateServiceNotification),拿 `update.message || update` 去读
 * `message.media` 会得到 undefined,26 字符的文本被静默算成 0 字符。
 */
export function extractObservation(update) {
    if (!update || typeof update !== 'object') {
        return null;
    }
    // gramjs 的类是 Proxy 生成的,constructor.name 恒为 "VirtualClass",
    // 拿不到真实类型。CONSTRUCTOR_ID 才是 TL 类型 ID。
    const typeId = extractTypeId(update);
    if (!typeId) {
        // 本地合成事件(如 UpdateConnectionState)没有 CONSTRUCTOR_ID,
        // 不是 Telegram update,记进去只会制造 Go 侧永远没有的噪声行。
        return null;
    }

    // 只有 Api.Message 才带 media / groupedId / message 三个字段。
    // 非消息类一律留空 —— 与 Go 侧 applyFeature 的 switch 对齐。
    const raw = update.message;
    const msg = (raw && typeof raw === 'object') ? raw : null;

    return {
        typeId,
        hasMedia: Boolean(msg?.media),
        textLen: typeof msg?.message === 'string' ? msg.message.length : 0,
        groupId: msg?.groupedId ?? null,
    };
}

/**
 * 启动记录器。由 AppInitializer 调用。
 */
export function startShadowRecorder() {
    if (!enabledByEnv()) {
        return;
    }
    enabled = true;
    counts.clear();

    flushTimer = setInterval(async () => {
        try {
            await flush();
        } catch (error) {
            // 记录失败绝不影响业务 —— 这是旁路。
            log.warn('影子记录落盘失败', { error: error.message });
        }
    }, 60_000);
    // 别让定时器吊住进程。
    if (flushTimer.unref) flushTimer.unref();

    log.info('👻 影子记录已启动(每 60s 落 Redis)', { key: KEY });
}

async function flush() {
    if (!enabled || flushing || counts.size === 0) return;
    flushing = true;
    try {
        const existing = (await cache.get(KEY, 'json', { skipCache: true, skipL3: true })) || {};

        for (const [fp, n] of counts) {
            existing[fp] = (existing[fp] || 0) + n;
        }

        // 整体按窗口过期 —— 影子验证的观察周期是小时级,不是天级。
        // cache.set 第三参数是【秒】,不是毫秒 —— 这坑记忆里踩过一次
        // (Redis keepAlive 把毫秒当秒),这里别再来一遍。
        //
        // skipTtlRandomization: CacheService 默认对 TTL 做 ±10% 抖动,
        // 而 Go 侧不知道窗口到底是 810 还是 990 秒,比对时无从对齐。
        //
        // 关键:cache.set 有三条「返回成功、实际什么都没写」的路
        // (failover 模式 / 无 Redis provider / 写入抛错后返回 false)。
        // 无条件 counts.clear() 会把这些计数静默丢掉,而影子结论正是
        // 基于这份数据 —— 丢了没人知道,diff 会误报。
        const ok = await cache.set(KEY, existing, WINDOW_SECONDS, {
            skipTtlRandomization: true,
            skipL3: true,
        });
        if (!ok) {
            log.warn('影子记录落盘失败,本轮计数保留待下次重试');
            return;
        }
        counts.clear();
        log.debug('影子记录已落盘', { kinds: Object.keys(existing).length });
    } finally {
        flushing = false;
    }
}

/**
 * 记录一条 update。由 MessageHandler 在业务判断之前调用。
 *
 * 刻意同步且永不抛 —— 它跑在消息处理的关键路径上。
 */
export function recordUpdate(update) {
    if (!enabled) return;

    try {
        const obs = extractObservation(update);
        if (!obs) return;
        const fp = computeFingerprint(obs);
        counts.set(fp, (counts.get(fp) || 0) + 1);
    } catch {
        // 静默:影子记录任何问题都不该影响线上。
    }
}

export function stopShadowRecorder() {
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
    enabled = false;
    counts.clear();
}

/**
 * 读取当前计数,供本地诊断用。
 */
export async function readShadowCounts() {
    return (await cache.get(KEY, 'json', { skipCache: true })) || {};
}