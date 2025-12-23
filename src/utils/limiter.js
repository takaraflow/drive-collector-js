import PQueue from "p-queue";

const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const createLimiter = (options) => {
    const { delayBetweenTasks = 0, ...queueOptions } = options;
    const queue = new PQueue(queueOptions);

    const run = (fn) => queue.add(async () => {
        const result = await fn();
        if (delayBetweenTasks > 0) await sleep(delayBetweenTasks);
        return result;
    });

    return { queue, run };
};

// Telegram Bot API：全局限流 30 QPS
const botGlobalLimiter = createLimiter({ intervalCap: 30, interval: 1000 });

// Telegram Bot API：单用户 1 QPS
const botUserLimiters = new Map();
const getUserLimiter = (userId) => {
    if (!userId) return botGlobalLimiter;
    if (!botUserLimiters.has(userId)) {
        botUserLimiters.set(userId, createLimiter({ intervalCap: 1, interval: 1000 }));
    }
    return botUserLimiters.get(userId);
};

/**
 * Bot API 调用限流封装：先过全局，再过用户维度
 */
export const runBotTask = (fn, userId) =>
    botGlobalLimiter.run(() => getUserLimiter(userId).run(fn));

// MTProto 文件传输：小并发 + 轻微延迟，减少 FloodWait
export const fileLimiter = createLimiter({ concurrency: 3, delayBetweenTasks: 50 });

// MTProto 通用队列（用于 getMessages / downloadMedia 等）
const mtprotoLimiter = createLimiter({ concurrency: 3, delayBetweenTasks: 50 });
export const runMtprotoTask = (fn) => mtprotoLimiter.run(fn);

// MTProto 认证：极低频率，避免封禁
export const authLimiter = createLimiter({ intervalCap: 1, interval: 60 * 1000 });

export const botLimiter = botGlobalLimiter;

