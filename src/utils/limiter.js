import PQueue from "p-queue";

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
 * 创建带自动缩放的限流器
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
    
    const run = (fn, addOptions = {}) =>
        queue.add(async () => {
            try {
                const result = await fn();
                successCount++;
                if (delayBetweenTasks > 0) await sleep(delayBetweenTasks);
                return result;
            } catch (error) {
                errorCount++;
                throw error;
            } finally {
                // 定期调整并发数
                this._adjustConcurrency(queue, autoScaling);
            }
        }, addOptions);
    
    const limiter = { queue, run };
    
    // 添加调整方法
    limiter.adjustConcurrency = () => this._adjustConcurrency(queue, autoScaling);
    
    return limiter;
};

/**
 * 调整并发数
 */
const _adjustConcurrency = (queue, autoScaling) => {
    const now = Date.now();
    const { min = 1, max = 10, factor = 0.8, interval = 5000 } = autoScaling;
    
    // 只在指定间隔内调整
    if (now - lastAdjustment < interval) return;
    lastAdjustment = now;
    
    // 计算成功率
    const total = successCount + errorCount;
    if (total === 0) return;
    
    const successRate = successCount / total;
    let newConcurrency = queue.concurrency;
    
    // 根据成功率调整并发数
    if (successRate > 0.9 && queue.size < queue.pending * 0.8) {
        // 成功率高且队列不满，可以增加并发
        newConcurrency = Math.min(max, Math.floor(queue.concurrency * (1 + (1 - factor))));
    } else if (successRate < 0.7 || errorCount > successCount * 0.3) {
        // 成功率低或错误过多，减少并发
        newConcurrency = Math.max(min, Math.floor(queue.concurrency * factor));
    }
    
    // 更新并发数
    if (newConcurrency !== queue.concurrency) {
        queue.concurrency = newConcurrency;
        console.log(`📊 Auto-scaling: Adjusted concurrency from ${queue.concurrency} to ${newConcurrency}`);
    }
    
    // 重置计数器
    successCount = 0;
    errorCount = 0;
};

/**
 * Token Bucket 算法实现
 * @param {number} capacity - 令牌桶容量
 * @param {number} fillRate - 填充速率（令牌/秒）
 */
const createTokenBucketLimiter = (capacity, fillRate) => {
    let tokens = capacity;
    let lastRefill = Date.now();
    
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
    
    return { take };
};

export const PRIORITY = {
    HIGH: 10,
    NORMAL: 0,
    LOW: -10
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
 * @param {Object} addOptions - 额外选项
 * @param {boolean} isFileUpload - 是否为文件上传操作
 */
export const runBotTask = (fn, userId, addOptions = {}, isFileUpload = false) => {
    const limiterChain = isFileUpload 
        ? botFileUploadLimiter.run(() => getUserLimiter(userId).run(fn, addOptions), addOptions)
        : getUserLimiter(userId).run(fn, addOptions);
    
    return botGlobalLimiter.run(() => limiterChain, addOptions);
};

// MTProto 文件传输：使用 token bucket 算法，30 请求突发，25/秒填充（带自动缩放）
const mtprotoFileTokenBucket = createTokenBucketLimiter(30, 25);
const mtprotoFileLimiter = createAutoScalingLimiter(
    { concurrency: 5 },
    { min: 3, max: 7, factor: 0.7, interval: 5000 }
);
export const runMtprotoFileTask = async (fn, addOptions = {}) => {
    while (!mtprotoFileTokenBucket.take()) {
        await sleep(100); // 等待令牌填充
    }
    return mtprotoFileLimiter.run(fn, addOptions);
};

// MTProto 通用队列（用于 getMessages / downloadMedia 等，带自动缩放）
const mtprotoLimiter = createAutoScalingLimiter(
    { concurrency: 5, delayBetweenTasks: 20 },
    { min: 3, max: 8, factor: 0.8, interval: 5000 }
);
export const runMtprotoTask = (fn, addOptions = {}) => mtprotoLimiter.run(fn, addOptions);

// MTProto 认证：1-5 次/分钟，并添加指数退避
const authTokenBucket = createTokenBucketLimiter(5, 5/60); // 5 令牌，5/60 令牌/秒
const authLimiter = createLimiter({ intervalCap: 5, interval: 60 * 1000 });
export const runAuthTask = async (fn, addOptions = {}) => {
    while (!authTokenBucket.take()) {
        await sleep(100); // 等待令牌填充
    }
    return authLimiter.run(fn, addOptions);
};

// 429 错误处理和重试机制
const handle429Error = async (fn, maxRetries = 3) => {
    let retryCount = 0;
    let lastRetryAfter = 0;
    
    while (retryCount < maxRetries) {
        try {
            return await fn();
        } catch (error) {
            // 检查是否为 429 错误
            if (error && (error.code === 429 || error.message.includes('429') || error.message.includes('FloodWait'))) {
                const retryAfter = error.retry_after ? parseInt(error.retry_after) : 
                                  error.message.match(/wait (\d+) seconds?/) ? 
                                  parseInt(error.message.match(/wait (\d+) seconds?/)[1]) * 1000 : 
                                  Math.min(1000 * (2 ** retryCount), 30000); // 指数退避，最大 30 秒
                
                console.warn(`429 error encountered, retrying after ${retryAfter}ms (attempt ${retryCount + 1}/${maxRetries})`);
                await sleep(retryAfter);
                retryCount++;
                lastRetryAfter = retryAfter;
            } else {
                throw error;
            }
        }
    }
    
    throw new Error(`Max retries (${maxRetries}) exceeded for 429 errors. Last retry-after: ${lastRetryAfter}ms`);
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

export const botLimiter = botGlobalLimiter;

