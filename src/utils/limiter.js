import PQueue from "p-queue";
import { kv } from "../services/kv.js";
import logger from "../services/logger.js";

const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const createLimiter = (options) => {
    const { delayBetweenTasks = 0, ...queueOptions } = options;
    const queue = new PQueue(queueOptions);

    const run = (fn, addOptions = {}) =>
        queue.add(async () => {
            const result = await fn();
            if (delayBetweenTasks > 0) await sleep(delayBetweenTasks);
            return result;
        }, addOptions);

    return { queue, run };
};

/**
 * 创建带自动缩放支持的限流器
 * @param {Object} options - 限流器选项
 * @param {Object} autoScaling - 自动缩放配置
 */
const createAutoScalingLimiter = (options, autoScaling = {}) => {
    const { delayBetweenTasks = 0, ...queueOptions } = options;
    
    // 初始并发数
    let currentConcurrency = queueOptions.concurrency || 1;
    
    // 创建队列
    const queue = new PQueue({
        ...queueOptions,
        concurrency: currentConcurrency
    });
    
    // 统计数据
    let successCount = 0;
    let errorCount = 0;
    let lastAdjustment = Date.now();

    const limiter = { queue, successCount, errorCount, lastAdjustment };

    limiter.adjustConcurrency = function() {
        const now = Date.now();
        const { min = 1, max = 10, factor = 0.8, interval = 5000 } = autoScaling;

        if (now - this.lastAdjustment < interval) return;
        this.lastAdjustment = now;

        const total = this.successCount + this.errorCount;
        if (total === 0) return;

        const successRate = this.successCount / total;
        let newConcurrency = queue.concurrency;

        if (successRate > 0.9) {
            newConcurrency = Math.min(max, Math.floor(queue.concurrency * (1 + (1 - factor))));
        } else if (successRate < 0.7 || this.errorCount > this.successCount * 0.3) {
            newConcurrency = Math.max(min, Math.floor(queue.concurrency * factor));
        }

        if (newConcurrency !== queue.concurrency) {
            queue.concurrency = newConcurrency;
            logger.info(`📊 Auto-scaling: Adjusted concurrency from ${queue.concurrency} to ${newConcurrency}`);
        }

        this.successCount = 0;
        this.errorCount = 0;
    };

    limiter.run = (fn, addOptions = {}) =>
        queue.add(async () => {
            try {
                const result = await fn();
                limiter.successCount++;
                if (delayBetweenTasks > 0) await sleep(delayBetweenTasks);
                return result;
            } catch (error) {
                limiter.errorCount++;
                throw error;
            } finally {
                limiter.adjustConcurrency();
            }
        }, addOptions);

    return limiter;
};

/**
 * Token Bucket 算法实现 (优化版，支持异步等待)
 * @param {number} capacity - 令牌桶容量
 * @param {number} fillRate - 填充速率（令牌/秒）
 */
const createTokenBucketLimiter = (capacity, fillRate) => {
    let tokens = capacity;
    let lastRefill = Date.now();
    let waitingQueue = [];

    const refill = () => {
        const now = Date.now();
        const elapsed = (now - lastRefill) / 1000;
        tokens = Math.min(capacity, tokens + elapsed * fillRate);
        lastRefill = now;
    };

    const take = (count = 1) => {
        refill();
        if (tokens >= count) {
            tokens -= count;
            return true;
        }
        return false;
    };

    /**
     * 异步获取令牌，如果没有可用令牌则等待
     * @param {number} count - 需要令牌数量
     * @returns {Promise<void>}
     */
    const takeAsync = async (count = 1) => {
        return new Promise((resolve) => {
            const tryTake = () => {
                if (take(count)) {
                    resolve();
                } else {
                    // 计算需要等待的时间
                    const waitTime = Math.max(100, (count - tokens) / fillRate * 1000);
                    setTimeout(tryTake, Math.min(waitTime, 1000)); // 最多等待1秒后重试
                }
            };
            tryTake();
        });
    };

    return { take, takeAsync };
};

export const PRIORITY = {
    UI: 20,      // UI 交互，最高优先级
    HIGH: 10,    // 重要状态更新
    NORMAL: 0,   // 普通消息/查询
    LOW: -10,    // 文件传输相关
    BACKGROUND: -20 // 后台清理/恢复任务
};

// Telegram Bot API：全局限流 30 QPS（带自动缩放）
const botGlobalLimiter = createAutoScalingLimiter(
    { intervalCap: 30, interval: 1000 },
    { min: 20, max: 30, factor: 0.8, interval: 5000 }
);

// Telegram Bot API：单用户 1 QPS
const botUserLimiters = new Map();
const getUserLimiter = (userId) => {
    if (!userId) return botGlobalLimiter;
    if (!botUserLimiters.has(userId)) {
        botUserLimiters.set(userId, createLimiter({ intervalCap: 1, interval: 1000 }));
    }
    return botUserLimiters.get(userId);
};

// Telegram Bot API：文件上传限流 20/分钟（带自动缩放）
const botFileUploadLimiter = createAutoScalingLimiter(
    { intervalCap: 20, interval: 60 * 1000 },
    { min: 15, max: 25, factor: 0.7, interval: 10000 }
);

/**
 * Bot API 调用限流封装：先过全局，再过用户维度
 * @param {Function} fn - 要执行的函数
 * @param {string} userId - 用户ID
 * @param {Object} addOptions - 额外选项 (包括 priority)
 * @param {boolean} isFileUpload - 是否为文件上传操作
 */
export const runBotTask = (fn, userId, addOptions = {}, isFileUpload = false) => {
    const priority = addOptions.priority ?? PRIORITY.NORMAL;
    const taskOptions = { ...addOptions, priority };

    const limiterChain = isFileUpload 
        ? botFileUploadLimiter.run(() => getUserLimiter(userId).run(fn, taskOptions), taskOptions)
        : getUserLimiter(userId).run(fn, taskOptions);
    
    return botGlobalLimiter.run(() => limiterChain, taskOptions);
};

// MTProto 文件传输：使用 token bucket 算法，30 请求突发，25/秒填充（带自动缩放）
const mtprotoFileTokenBucket = createTokenBucketLimiter(30, 25);
const mtprotoFileLimiter = createAutoScalingLimiter(
    { concurrency: 5 },
    { min: 3, max: 7, factor: 0.7, interval: 5000 }
);
export const runMtprotoFileTask = async (fn, addOptions = {}) => {
    const priority = addOptions.priority ?? PRIORITY.LOW;
    const taskOptions = { ...addOptions, priority };

    // 使用异步令牌获取，避免 CPU 浪费的 while 循环
    await mtprotoFileTokenBucket.takeAsync();
    return mtprotoFileLimiter.run(fn, taskOptions);
};

// MTProto 通用队列（用于 getMessages / downloadMedia 等，带自动缩放）
const mtprotoLimiter = createAutoScalingLimiter(
    { concurrency: 5, delayBetweenTasks: 20 },
    { min: 3, max: 8, factor: 0.8, interval: 5000 }
);
export const runMtprotoTask = (fn, addOptions = {}) => {
    const priority = addOptions.priority ?? PRIORITY.NORMAL;
    const taskOptions = { ...addOptions, priority };
    return mtprotoLimiter.run(fn, taskOptions);
};

// MTProto 认证：1-5 次/分钟，并添加指数退避
const authTokenBucket = createTokenBucketLimiter(5, 5/60); // 5 令牌，5/60 令牌/秒
const authLimiter = createLimiter({ intervalCap: 5, interval: 60 * 1000 });
export const runAuthTask = async (fn, addOptions = {}) => {
    // 使用异步令牌获取，避免 CPU 浪费的 while 循环
    await authTokenBucket.takeAsync();
    return authLimiter.run(fn, addOptions);
};

// 全局冷静期状态
let globalCoolingUntil = 0;
let lastKVCheck = 0;

/**
 * 检查是否处于冷静期 (通过内存 + KV 同步)
 */
const checkCooling = async () => {
    const now = Date.now();
    
    // 1. 如果本地已经处于冷静期，直接等待，不需要同步 KV
    if (now < globalCoolingUntil) {
        const waitTime = globalCoolingUntil - now;
        logger.warn(`❄️ System is in LOCAL cooling period, waiting ${waitTime}ms...`);
        await sleep(waitTime);
        return;
    }

    // 2. 每 30 秒从 KV 同步一次全局冷却状态（延长同步间隔）
    if (now - lastKVCheck > 30000) {
        try {
            // 使用缓存读取，虽然 kv.get 已经有了 L1，但这里显式设置较长 TTL
            const remoteCooling = await kv.get("system:cooling_until", "text", { cacheTtl: 30000 });
            if (remoteCooling) {
                globalCoolingUntil = Math.max(globalCoolingUntil, parseInt(remoteCooling));
            }
            lastKVCheck = now;
        } catch (e) {}
    }

    if (now < globalCoolingUntil) {
        const waitTime = globalCoolingUntil - now;
        logger.warn(`❄️ System is in global cooling period, waiting ${waitTime}ms...`);
        await sleep(waitTime);
    }
};

// 429 错误处理和重试机制
const handle429Error = async (fn, maxRetries = 3) => {
    let retryCount = 0;
    let lastRetryAfter = 0;
    
    while (retryCount < maxRetries) {
        await checkCooling();
        try {
            return await fn();
        } catch (error) {
            // 检查是否为 429 错误或 FloodWaitError
            const isFlood = error && (
                error.code === 429 || 
                error.message.includes('429') || 
                error.message.includes('FloodWait') ||
                error.name === 'FloodWaitError'
            );

            if (isFlood) {
                // 提取等待时间，如果大于 60 秒，触发全局冷静期
                let retryAfter = error.retryAfter || error.seconds || 0;
                if (!retryAfter) {
                    const match = error.message.match(/wait (\d+) seconds?/);
                    retryAfter = match ? parseInt(match[1]) : 0;
                }
                
                // 将秒转为毫秒，并加上一些抖动
                const waitMs = (retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * (2 ** retryCount), 60000)) + Math.random() * 1000;
                
                if (retryAfter > 60) {
                    logger.error(`🚨 Large FloodWait detected (${retryAfter}s). Triggering GLOBAL cooling.`);
                    globalCoolingUntil = Date.now() + waitMs;
                    // 同步到 KV
                    await kv.set("system:cooling_until", globalCoolingUntil.toString(), Math.ceil(waitMs / 1000) + 60).catch(() => {});
                }

                logger.warn(`⚠️ 429/FloodWait encountered, retrying after ${Math.round(waitMs)}ms (attempt ${retryCount + 1}/${maxRetries})`);
                await sleep(waitMs);
                retryCount++;
                lastRetryAfter = waitMs;
            } else {
                throw error;
            }
        }
    }
    
    throw new Error(`Max retries (${maxRetries}) exceeded for 429 errors. Last retry-after: ${Math.round(lastRetryAfter)}ms`);
};

// 封装带重试的任务执行
export const runBotTaskWithRetry = async (fn, userId, addOptions = {}, isFileUpload = false, maxRetries = 3) => {
    return handle429Error(() => runBotTask(fn, userId, addOptions, isFileUpload), maxRetries);
};

export const runMtprotoTaskWithRetry = async (fn, addOptions = {}, maxRetries = 3) => {
    return handle429Error(() => runMtprotoTask(fn, addOptions), maxRetries);
};

export const runMtprotoFileTaskWithRetry = async (fn, addOptions = {}, maxRetries = 3) => {
    return handle429Error(() => runMtprotoFileTask(fn, addOptions), maxRetries);
};

export const runAuthTaskWithRetry = async (fn, addOptions = {}, maxRetries = 3) => {
    return handle429Error(() => runAuthTask(fn, addOptions), maxRetries);
};

export { handle429Error, createAutoScalingLimiter }; // 导出以供测试
export const botLimiter = botGlobalLimiter;