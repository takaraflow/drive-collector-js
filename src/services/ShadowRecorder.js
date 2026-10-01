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
const WINDOW_MS = 15 * 60 * 1000;
const KEY = 'shadow:counts';

let enabled = false;
let flushTimer = null;

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
 * 只取 Node 和 Go 都能算出来的量 —— gramjs 逐条回调,gotd 收批次,
 * 所以批次级别的维度(一次收到几条)在这里拿不到,也不该出现在指纹里。
 */
export function extractObservation(update) {
    if (!update || typeof update !== 'object') {
        return null;
    }
    // 用 CONSTRUCTOR_ID(TL 类型 ID)而不是类名 —— gramjs 的类是 Proxy
    // 生成的,constructor.name 恒为 "VirtualClass",拿不到真实类型。
    const typeId = extractTypeId(update);

    const message = update.message || update;
    const media = message?.media || message?.document || message?.photo || null;
    const groupedId = message?.groupedId ?? null;
    const text = typeof message?.message === 'string' ? message.message : '';

    return {
        typeId,
        hasMedia: Boolean(media),
        textLen: text.length,
        groupId: groupedId,
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
    if (!enabled || counts.size === 0) return;

    const existing = (await cache.get(KEY, 'json', { skipCache: true })) || {};

    for (const [fp, n] of counts) {
        existing[fp] = (existing[fp] || 0) + n;
    }

    // 整体按窗口过期 —— 影子验证的观察周期是小时级,不是天级。
    await cache.set(KEY, existing, { ttl: WINDOW_MS });
    counts.clear();
    log.debug('影子记录已落盘', { kinds: Object.keys(existing).length });
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