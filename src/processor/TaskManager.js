import PQueue from "p-queue";
import { randomUUID } from "crypto";
import path from "path";
import fs from "fs";
import { Button } from "telegram/tl/custom/button.js";
import { dependencyContainer } from "../services/DependencyContainer.js";
import { TASK_ACTIVE_STATUSES, TASK_EVENTS, TASK_STATUSES, TASK_TERMINAL_STATUSES } from "../domain/task-state-machine.js";
import { escapeHTML } from "../utils/common.js";
import {
    isTaskProcessingLockBusyError,
    TaskProcessingLockBusyError,
    TASK_QUEUE_TRIGGER_SOURCES
} from "../domain/task-queue-contract.js";
import {
    classifyInfrastructureError,
    isRetryableInfrastructureError
} from "../domain/infrastructure-error.js";
import { isRetryableRcloneError } from "../domain/rclone-error.js";
import {
    attachClaimLease,
    getClaimFenceOptions
} from "./TaskManager/claim-fence.js";
import {
    TASK_SOURCE_TYPES,
    buildExternalUrlSourceRef,
    buildTelegramMediaSourceRef,
    isExternalUrlTask,
    parseTaskSourceRef
} from "../domain/task-source.js";
import { buildExternalLocalFileName } from "./ExternalUrlPolicy.js";
import { buildTaskObjectFromDb, resolveStoredTaskSource, resolveTaskSource } from "./TaskManager/TaskSourceResolver.js";
import { redactSensitiveText } from "../utils/serializer.js";

// 导入模块化的方法
import { downloadTask } from "./TaskManager/TaskManager.download.js";
import { uploadTask } from "./TaskManager/TaskManager.upload.js";
import { downloadExternalUrlTask } from "./TaskManager/TaskManager.external-download.js";

// 获取依赖项的辅助函数
const getDeps = () => dependencyContainer.getAll();
const getLog = () => getDeps().logger.withModule('TaskManager');
const ACTIVE_STATUS_SET = new Set(TASK_ACTIVE_STATUSES);
const TERMINAL_STATUS_SET = new Set(TASK_TERMINAL_STATUSES);
const MANUAL_RETRY_ALLOWED_STATUS_SET = new Set([
    TASK_STATUSES.FAILED,
    TASK_STATUSES.QUEUED
]);
const TELEGRAM_CLIENT_LOCK_KEY = "telegram_client";
const STALLED_RECOVERY_LOCK_KEY = "task_recovery:stalled";
const STALLED_RECOVERY_LOCK_TTL_SECONDS = 120;
const STALLED_RECOVERY_INTERVAL_MS = 60_000;
const STALLED_RECOVERY_TIMEOUT_MS = 120_000;

/**
 * --- 任务管理调度中心 (TaskManager) ---
 * 
 * 核心设计决策：
 * 1. QStash 驱动：移除了传统的基于内存和定时器的 UploadBatcher 机制。
 *    之前版本在高并发和多实例环境下容易出现内存溢出和状态不一致问题。
 *    现在的 QStash 延迟队列方案实现了分布式的批处理和自动重试，具备极高的可靠性。
 * 
 * 2. 状态机驱动：任务状态流转（queued -> downloading -> downloaded -> uploading -> completed）
 *    完全由数据库和消息队列共同保障，支持实例重启后的无损恢复。
 * 负责队列管理、任务恢复、以及具体的下载/上传流程编排
 */
export class TaskManager {
    /**
     * 批量更新任务状态
     * @param {Array<{id: string, status: string, error?: string}>} updates
     */
    static async batchUpdateStatus(updates) {
        if (!updates || updates.length === 0) return;
        const { TaskRepository } = getDeps();
        const log = getLog();

        try {
            const results = await Promise.allSettled(updates.map(update =>
                TaskRepository.transitionStatus(update.id, update.event || update.status, update.error, {
                    returnResult: true,
                    allowNoop: true,
                    source: 'TaskManager.batchUpdateStatus'
                })
            ));

            const failed = results.filter(result => result.status === 'rejected');
            if (failed.length > 0) {
                throw failed[0].reason;
            }
        } catch (e) {
            log.error("batchUpdateStatus failed", e);
            // 降级到单个更新
            for (const update of updates) {
                try {
                    await TaskRepository.transitionStatus(update.id, update.event || update.status, update.error, {
                        allowNoop: true,
                        source: 'TaskManager.batchUpdateStatus.fallback'
                    });
                } catch (err) {
                    log.error("Failed to update task", { taskId: update.id, error: err });
                }
            }
        }
    }

    // QStash 事件驱动：移除传统队列，改为 Webhook 处理

    // 兼容性：保留原有queue引用
    static get queue() { return this.downloadQueue; }
    static set queue(value) { this.downloadQueue = value; }

    static waitingTasks = [];
    static currentTask = null; // 兼容旧代码：当前正在下载的任务
    static processingUploadTasks = new Set(); // 正在上传的任务
    static waitingUploadTasks = []; // 等待上传的任务队列
    static stalledRecoveryTimer = null;
    static stalledRecoveryInProgress = false;
    
    // Max queue size limits to prevent unbounded growth
    static MAX_WAITING_TASKS = 1000;
    static MAX_WAITING_UPLOAD_TASKS = 500;
    
    // UI更新节流控制
    static uiUpdateTracker = {
        count: 0,
        windowStart: Date.now(),
        windowSize: 10000, // 10秒窗口
        maxUpdates: 20 // 窗口内最大20次UI更新
    };
    
    /**
     * 获取当前正在处理的任务总数 (下载中 + 上传中)
     */
    static getProcessingCount() {
        let count = 0;
        if (this.currentTask) count++;
        count += this.processingUploadTasks.size;
        return count;
    }

    /**
     * 获取等待中的任务总数 (下载排队 + 上传排队)
     */
    static getWaitingCount() {
        return this.waitingTasks.length + this.waitingUploadTasks.length;
    }
    
    /**
     * Enforce max queue size limits for waiting tasks arrays
     * Removes oldest entries when limits are exceeded
     */
    static enforceQueueSizeLimits() {
        // Trim waitingTasks if over limit
        if (this.waitingTasks.length > this.MAX_WAITING_TASKS) {
            this.waitingTasks = this.waitingTasks.slice(-this.MAX_WAITING_TASKS);
        }
        
        // Trim waitingUploadTasks if over limit
        if (this.waitingUploadTasks.length > this.MAX_WAITING_UPLOAD_TASKS) {
            this.waitingUploadTasks = this.waitingUploadTasks.slice(-this.MAX_WAITING_UPLOAD_TASKS);
        }
    }

    /**
     * @deprecated Use getWaitingCount instead
     */
    static waitingCount() {
        return this.getWaitingCount();
    }

    /**
     * @deprecated Use getProcessingCount instead
     */
    static processingCount() {
        return this.getProcessingCount();
    }

    // 内存中的任务执行锁，防止同一任务被多次 processor 处理
    static activeProcessors = new Set();

    // 运行中任务对象引用（用于取消正在处理的任务）
    static inFlightTasks = new Map(); // taskId -> task object

    // 用户取消标记（用于 QStash 触发前/中途快速拦截）
    static cancelledTaskIds = new Set();

    /**
     * 初始化：恢复因重启中断的僵尸任务
     */
    static async init() {
        const { cache } = getDeps();
        const log = getLog();
        log.info("正在检查数据库中异常中断的任务");

        // 安全检查：如果处于 Cache 故障转移模式，延迟任务恢复以优先让主集群处理
        if (cache.isFailoverMode) {
            log.warn("系统处于 Cache 故障转移模式", { cache_provider: 'upstash', delay: 30000 });

            // 先预加载常用数据
            await this._preloadCommonData();

            // 延迟 30 秒
            await new Promise(resolve => setTimeout(resolve, 30000));
            log.info("故障转移实例开始执行延迟恢复检查");
        }

        try {
            await this._runStalledTaskRecovery({ includeRetryableFailed: true });
        } catch (e) {
            log.error("TaskManager.init critical error", e);
        } finally {
            this._startStalledRecoveryLoop();
        }
    }

    static _startStalledRecoveryLoop() {
        const log = getLog();
        if (this.stalledRecoveryTimer) return;

        this.stalledRecoveryTimer = setInterval(() => {
            void this._runStalledTaskRecovery({ includeRetryableFailed: true })
                .catch(error => log.warn("Periodic stalled task recovery failed", {
                    error: error.message
                }));
        }, STALLED_RECOVERY_INTERVAL_MS);

        if (typeof this.stalledRecoveryTimer.unref === 'function') {
            this.stalledRecoveryTimer.unref();
        }
        log.info("周期性任务恢复扫描已启动", { intervalMs: STALLED_RECOVERY_INTERVAL_MS });
    }

    static stopStalledRecoveryLoop() {
        if (this.stalledRecoveryTimer) {
            clearInterval(this.stalledRecoveryTimer);
            this.stalledRecoveryTimer = null;
        }
        this.stalledRecoveryInProgress = false;
    }

    static async _runStalledTaskRecovery(options = {}) {
        const { TaskRepository, instanceCoordinator } = getDeps();
        const log = getLog();

        if (this.stalledRecoveryInProgress) {
            log.debug("任务恢复扫描仍在运行，跳过本轮");
            return { restored: 0, skipped: true };
        }

        let recoveryLockAcquired = false;
        this.stalledRecoveryInProgress = true;
        try {
            const leaderLease = await this._getTelegramClientLease(instanceCoordinator);
            if (!leaderLease) {
                log.info("当前实例未持有 Telegram 处理租约，跳过任务恢复扫描");
                return { restored: 0, skipped: true, reason: 'not_telegram_leader' };
            }

            if (instanceCoordinator && typeof instanceCoordinator.acquireLock === 'function') {
                recoveryLockAcquired = await instanceCoordinator.acquireLock(
                    STALLED_RECOVERY_LOCK_KEY,
                    STALLED_RECOVERY_LOCK_TTL_SECONDS,
                    { maxAttempts: 1, logContention: false }
                );
                if (!recoveryLockAcquired) {
                    log.info("另一个实例正在执行任务恢复扫描，当前实例跳过");
                    return { restored: 0, skipped: true };
                }
            }

            const currentLeaderLease = await this._getTelegramClientLease(instanceCoordinator);
            if (!currentLeaderLease) {
                log.info("任务恢复租约已获取，但当前实例不再持有 Telegram 处理租约，跳过任务恢复扫描");
                return { restored: 0, skipped: true, reason: 'lost_telegram_leader' };
            }

            const results = await Promise.allSettled([
                TaskRepository.findStalledTasks(STALLED_RECOVERY_TIMEOUT_MS, {
                    includeRetryableFailed: options.includeRetryableFailed === true
                }),
                this._preloadCommonData()
            ]);
            const tasks = results[0].status === 'fulfilled' ? results[0].value : [];
            if (!tasks || tasks.length === 0) {
                log.info("没有发现僵尸任务");
                return { restored: 0, skipped: false };
            }

            log.info("发现僵尸任务", { count: tasks.length, action: 'batch_restore' });
            const chatGroups = this._groupRecoverableRowsByChat(tasks);
            let restored = 0;
            const groupedChats = [...chatGroups.entries()];
            for (let index = 0; index < groupedChats.length; index += 1) {
                const [chatId, rows] = groupedChats[index];
                const result = await this._restoreBatchTasks(chatId, rows);
                restored += result?.enqueued || 0;
                if (index < groupedChats.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }

            this.updateQueueUI();
            return { restored, skipped: false };
        } finally {
            this.stalledRecoveryInProgress = false;
            if (recoveryLockAcquired && typeof instanceCoordinator?.releaseLock === 'function') {
                await instanceCoordinator.releaseLock(STALLED_RECOVERY_LOCK_KEY);
            }
        }
    }

    static _groupRecoverableRowsByChat(rows) {
        const log = getLog();
        const chatGroups = new Map();
        for (const row of rows) {
            if (!row.chat_id || row.chat_id.includes("Object")) {
                log.warn("跳过无效 chat_id 的任务", { taskId: row.id, chatId: row.chat_id });
                continue;
            }
            if (!chatGroups.has(row.chat_id)) {
                chatGroups.set(row.chat_id, []);
            }
            chatGroups.get(row.chat_id).push(row);
        }
        return chatGroups;
    }

    /**
     * [私有] 预加载常用数据，提升后续操作性能
     */
    static async _preloadCommonData() {
        const log = getLog();
        const preloadTasks = [];

        try {
            // 并行预加载多个数据源
            preloadTasks.push(
                // 预加载活跃驱动列表（已实现缓存）
                import("../repositories/DriveRepository.js").then(({ DriveRepository }) =>
                    DriveRepository.findAll()
                ),

                // 预加载配置文件缓存
                import("../config/index.js").then(({ getConfig }) => {
                    // 预热配置访问，避免首次访问时的延迟
                    return Promise.resolve(getConfig());
                }),

                // 预加载本地化字符串缓存
                import("../locales/zh-CN.js").then(({ STRINGS }) => {
                    // 预热字符串访问
                    return Promise.resolve(Object.keys(STRINGS).length);
                }),

                // 预加载常用工具函数
                import("../utils/common.js").then(({ getMediaInfo, escapeHTML }) => {
                    // 预热函数引用
                    return Promise.resolve({ getMediaInfo, escapeHTML });
                }),

                // 预热缓存服务
                import("../utils/LocalCache.js").then(({ localCache }) => {
                    // 确保缓存服务已初始化
                    return Promise.resolve(localCache);
                }),

                // 预加载 Cache 服务
                import("../services/CacheService.js").then(({ cache }) => {
                    // 预热 Cache 连接
                    return cache.get("system:health_check", "text").catch(() => "ok");
                })
            );

            // 并行执行所有预加载任务
            const results = await Promise.allSettled(preloadTasks);

            // 统计预加载结果
            const successCount = results.filter(r => r.status === 'fulfilled').length;
            const totalCount = results.length;

            log.info("预加载常用数据完成", { successCount, totalCount });

            // 如果大部分预加载失败，记录警告
            if (successCount < totalCount * 0.7) {
                log.warn("预加载成功率较低", { successCount, totalCount });
            }

        } catch (e) {
            log.warn("预加载数据失败", e);
        }
    }

    /**
     * [私有] 批量恢复同一个会话下的任务
     */
    static async _restoreBatchTasks(chatId, rows) {
        const { config, TaskRepository, STRINGS, format } = getDeps();
        const log = getLog();
        try {
            // 预处理任务，分离有效和无效任务
            const failedUpdates = [];
            const tasksToEnqueue = [];
            const tasksToUpload = [];

            const msgIdCounts = new Map();
            for (const row of rows) {
                const key = row.msg_id == null ? row.id : String(row.msg_id);
                msgIdCounts.set(key, (msgIdCounts.get(key) || 0) + 1);
            }

            for (const row of rows) {
                let task;
                try {
                    task = buildTaskObjectFromDb(row, resolveStoredTaskSource(row));
                } catch (error) {
                    log.warn("任务源元数据缺失，无法恢复", { taskId: row.id, error: error.message });
                    failedUpdates.push({ id: row.id, event: TASK_EVENTS.FAIL, error: error.message });
                    continue;
                }

                const msgKey = row.msg_id == null ? row.id : String(row.msg_id);
                if ((msgIdCounts.get(msgKey) || 0) > 1) {
                    task.isGroup = true;
                }

                // 根据任务状态决定恢复到哪个队列
                if (row.status === TASK_STATUSES.DOWNLOADED || row.status === TASK_STATUSES.UPLOADING) {
                    // 恢复到上传队列
                    const localFileName = isExternalUrlTask(row)
                        ? buildExternalLocalFileName(row.id, row.file_name || task.sourceRef?.fileName)
                        : path.basename(row.file_name);
                    const localPath = path.join(config.downloadDir, localFileName);
                    if (fs.existsSync(localPath)) {
                        const reset = await TaskRepository.transitionStatus(row.id, TASK_EVENTS.RESET_UPLOAD, null, {
                            returnResult: true,
                            allowNoop: true,
                            source: 'restore_uploadable_task'
                        });
                        if (reset.blocked) {
                            log.warn("上传恢复状态机阻止任务", { taskId: row.id, reason: reset.reason });
                            continue;
                        }
                        task.queueAttempt = reset.queueAttempt;
                        task.localPath = localPath;
                        tasksToUpload.push(task);
                        log.info(`📤 恢复可上传任务 ${row.id} 到上传队列`);
                    } else {
                        // 本地文件不存在，重新下载
                        const reset = await TaskRepository.transitionStatus(row.id, TASK_EVENTS.RETRY, 'Local file missing during recovery', {
                            returnResult: true,
                            allowNoop: true,
                            source: 'restore_uploading_missing_file'
                        });
                        if (reset.blocked) {
                            log.warn("缺失本地文件的上传任务无法复位下载", { taskId: row.id, reason: reset.reason });
                            continue;
                        }
                        task.queueAttempt = reset.queueAttempt;
                        log.warn(`⚠️ 本地文件不存在，重新下载任务 ${row.id}`);
                        tasksToEnqueue.push(task);
                    }
                } else if (row.status === TASK_STATUSES.QUEUED || row.status === TASK_STATUSES.DOWNLOADING || row.status === TASK_STATUSES.FAILED) {
                    if (row.status === TASK_STATUSES.FAILED && !this._isRetryableStalledFailure(row)) {
                        log.warn("跳过不可自动恢复的失败任务", { taskId: row.id });
                        continue;
                    }
                    const resetSource = row.status === TASK_STATUSES.FAILED
                        ? 'restore_retryable_failed_task'
                        : row.status === TASK_STATUSES.DOWNLOADING
                            ? 'restore_downloading_task'
                            : 'restore_queued_task';
                    const resetReason = row.status === TASK_STATUSES.QUEUED
                        ? null
                        : 'Downloading interrupted during recovery';
                    const reset = await TaskRepository.transitionStatus(row.id, TASK_EVENTS.RETRY, resetReason, {
                        returnResult: true,
                        allowNoop: true,
                        source: resetSource
                    });
                    if (reset.blocked) {
                        log.warn("任务无法复位下载", { taskId: row.id, reason: reset.reason, status: row.status });
                        continue;
                    }
                    // 恢复到下载队列。即使原状态已经是 queued，也通过状态机刷新 updated_at/queueAttempt，
                    // 避免旧 QStash 消息和恢复消息共享幂等键导致 UI 停在恢复提示。
                    task.queueAttempt = reset.queueAttempt;
                    tasksToEnqueue.push(task);
                } else {
                    log.warn("跳过不支持恢复的任务状态", { taskId: row.id, status: row.status });
                }
            }

            // 批量更新失败状态
            if (failedUpdates.length > 0) {
                await this.batchUpdateStatus(failedUpdates);
            }

            const enqueueWork = [
                ...tasksToEnqueue.map(task => ({ task, type: 'download', run: () => this._enqueueTask(task) })),
                ...tasksToUpload.map(task => ({ task, type: 'upload', run: () => this._enqueueUploadTask(task) }))
            ];
            if (enqueueWork.length === 0) {
                return { enqueued: 0, pendingRetry: 0, failed: failedUpdates.length };
            }

            const enqueueResults = await Promise.allSettled(enqueueWork.map(work => work.run()));
            const failed = enqueueResults
                .map((result, index) => ({ result, work: enqueueWork[index] }))
                .filter(item => item.result.status === 'rejected');
            const succeeded = enqueueResults
                .map((result, index) => ({ result, work: enqueueWork[index] }))
                .filter(item => item.result.status === 'fulfilled');
            let fallbackSucceeded = [];

            await this._notifyRecoveredTasks(
                succeeded.map(({ work }) => work.task),
                STRINGS.task.restore
            );

            if (failed.length > 0) {
                const retryableFailures = failed.filter(({ result }) => this._isRetryableInfrastructureError(result.reason));
                const terminalFailures = failed.filter(({ result }) => !this._isRetryableInfrastructureError(result.reason));
                let fallbackFailed = [];

                if (retryableFailures.length > 0) {
                    log.warn("恢复任务入队暂时失败，将由周期扫描继续重试", {
                        count: retryableFailures.length,
                        taskIds: retryableFailures.map(({ work }) => work.task.id),
                        reason: redactSensitiveText(retryableFailures[0].result.reason?.message || String(retryableFailures[0].result.reason))
                    });
                    const fallbackResults = await this._runRecoveryLocalFallback(retryableFailures);
                    fallbackSucceeded = fallbackResults.succeeded;
                    fallbackFailed = fallbackResults.failed;
                    if (fallbackFailed.length > 0) {
                        await this._notifyRecoveredTasks(
                            fallbackFailed.map(({ work }) => work.task),
                            STRINGS.task.recovery_pending
                        );
                    }
                }

                if (terminalFailures.length > 0) {
                    await Promise.allSettled(terminalFailures.map(async ({ result, work }) => {
                        const reason = redactSensitiveText(result.reason?.message || String(result.reason));
                        await this._markTaskFailed(
                            work.task.id,
                            `Recovery enqueue failed: ${reason}`,
                            `restore_${work.type}_enqueue_failed`
                        );
                        await this._notifyRecoveredTasks(
                            [work.task],
                            format(STRINGS.task.failed_action_required, {
                                reason: escapeHTML(`恢复队列失败：${reason}`)
                            }),
                            true
                        );
                    }));
                    throw new Error(`Recovery enqueue failed for ${terminalFailures.length} task(s): ${redactSensitiveText(terminalFailures[0].result.reason?.message || String(terminalFailures[0].result.reason))}`);
                }
            }

            return {
                enqueued: succeeded.length + fallbackSucceeded.length,
                pendingRetry: failed.length - fallbackSucceeded.length,
                failed: failedUpdates.length
            };

        } catch (e) {
            log.error(`批量恢复会话 ${chatId} 的任务失败:`, e);
            throw e;
        }
    }

    static async _notifyRecoveredTasks(tasks, text, isFinal = false) {
        const { updateStatus } = getDeps();
        const BATCH_SIZE = 2;
        for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
            const batch = tasks.slice(i, i + BATCH_SIZE);
            await Promise.allSettled(batch.map(task =>
                this.canUpdateUI()
                    ? updateStatus(task, text, isFinal)
                    : Promise.resolve()
            ));
            if (i + BATCH_SIZE < tasks.length) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }
    }

    static async _runRecoveryLocalFallback(retryableFailures) {
        const log = getLog();
        const results = await Promise.allSettled(retryableFailures.map(async ({ work, result }) => {
            log.warn("恢复队列不可用，切换为当前实例直接恢复任务", {
                taskId: work.task.id,
                type: work.type,
                reason: redactSensitiveText(result.reason?.message || String(result.reason))
            });
            const webhookResult = work.type === 'upload'
                ? await this.handleUploadWebhook(work.task.id)
                : await this.handleDownloadWebhook(work.task.id);
            if (!webhookResult?.success) {
                throw new Error(webhookResult?.message || `Local recovery fallback failed with status ${webhookResult?.statusCode || 'unknown'}`);
            }
            return webhookResult;
        }));

        return {
            succeeded: results
                .map((result, index) => ({ result, work: retryableFailures[index].work }))
                .filter(item => item.result.status === 'fulfilled'),
            failed: results
                .map((result, index) => ({ result, work: retryableFailures[index].work }))
                .filter(item => item.result.status === 'rejected')
        };
    }

    static _isRetryableStalledFailure(row) {
        if (row?.status !== TASK_STATUSES.FAILED) return false;
        const message = row.error_msg || row.error || "";
        if (!message) return false;
        return this._isRetryableInfrastructureError(new Error(message)) || isRetryableRcloneError(message);
    }

    static _resolveBlockedWebhookResult(kind, transitionResult, fallbackStatus = null) {
        const status = transitionResult?.fromStatus || transitionResult?.latestStatus || fallbackStatus || null;
        if (ACTIVE_STATUS_SET.has(status)) {
            return {
                success: false,
                statusCode: 503,
                message: `${kind} task is active; retry later`
            };
        }
        return {
            success: true,
            statusCode: 200,
            message: TERMINAL_STATUS_SET.has(status)
                ? "Task already terminal"
                : `Ignored by ${kind} state machine`
        };
    }

    /**
     * 添加新任务到队列
     */
    static async addTask(target, mediaMessage, userId, customLabel = "") {
        const { client, format, STRINGS, PRIORITY, TaskRepository, getMediaInfo, runBotTaskWithRetry } = getDeps();
        const log = getLog();
        const taskId = randomUUID();
        const chatIdStr = (target?.userId ?? target?.chatId ?? target?.channelId ?? target?.id ?? target).toString();

        const statusMsg = await runBotTaskWithRetry(
            () => client.sendMessage(target, {
                message: format(STRINGS.task.captured, { label: customLabel }),
                buttons: [Button.inline(STRINGS.task.cancel_btn, Buffer.from(`cancel_confirm_${taskId}`))],
                parseMode: "html"
            }),
            userId,
            { priority: PRIORITY.UI },
            false,
            10
        );

        const info = getMediaInfo(mediaMessage);

        let taskCreated = false;
        try {
            await TaskRepository.create({
                id: taskId,
                userId: userId.toString(),
                chatId: chatIdStr,
                msgId: statusMsg.id,
                sourceMsgId: mediaMessage.id,
                sourceType: TASK_SOURCE_TYPES.TELEGRAM_MEDIA,
                sourceRef: buildTelegramMediaSourceRef({ chatId: chatIdStr, messageId: mediaMessage.id }),
                fileName: info?.name,
                fileSize: info?.size
            });
            taskCreated = true;

            // 立即推送到 QStash 队列
            const task = this._createTaskObject(taskId, userId, chatIdStr, statusMsg.id, mediaMessage);
            await this._enqueueTask(task);
            log.info("Task created and enqueued", { taskId, status: 'enqueued' });

        } catch (e) {
            log.error("Task creation failed", e);
            if (taskCreated) {
                await this._markTaskFailed(taskId, `Queue enqueue failed: ${e.message}`, 'addTask.enqueue_failed');
            }
            // 尝试更新状态消息，如果失败则记录但不抛出异常
            try {
                await client.editMessage(target, {
                    message: statusMsg.id,
                    text: STRINGS.task.create_failed
                });
            } catch (editError) {
                log.warn("Failed to update error message", { error: editError.message });
            }
            throw e;
        }
    }

    static async addExternalUrlTask(target, externalSource, userId) {
        const { client, format, STRINGS, PRIORITY, TaskRepository, runBotTaskWithRetry } = getDeps();
        const log = getLog();
        const taskId = randomUUID();
        const chatIdStr = (target?.userId ?? target?.chatId ?? target?.channelId ?? target?.id ?? target).toString();
        const sourceRef = buildExternalUrlSourceRef(externalSource);

        const statusMsg = await runBotTaskWithRetry(
            () => client.sendMessage(target, {
                message: format(STRINGS.task.external_captured, { name: escapeHTML(sourceRef.fileName) }),
                buttons: [Button.inline(STRINGS.task.cancel_btn, Buffer.from(`cancel_confirm_${taskId}`))],
                parseMode: "html"
            }),
            userId,
            { priority: PRIORITY.UI },
            false,
            10
        );

        let taskCreated = false;
        try {
            await TaskRepository.create({
                id: taskId,
                userId: userId.toString(),
                chatId: chatIdStr,
                msgId: statusMsg.id,
                sourceMsgId: null,
                sourceType: TASK_SOURCE_TYPES.EXTERNAL_URL,
                sourceRef,
                fileName: sourceRef.fileName,
                fileSize: sourceRef.fileSize || 0
            });
            taskCreated = true;

            const task = {
                id: taskId,
                userId: userId.toString(),
                chatId: chatIdStr,
                msgId: statusMsg.id,
                sourceType: TASK_SOURCE_TYPES.EXTERNAL_URL,
                sourceRef,
                fileName: sourceRef.fileName,
                fileInfo: { name: sourceRef.fileName, size: sourceRef.fileSize || 0 },
                lastText: "",
                isCancelled: false
            };
            await this._enqueueTask(task);
            log.info("External URL task created and enqueued", { taskId, status: "enqueued" });
            return taskId;
        } catch (e) {
            log.error("External URL task creation failed", e);
            if (taskCreated) {
                await this._markTaskFailed(taskId, `Queue enqueue failed: ${e.message}`, "addExternalUrlTask.enqueue_failed");
            }
            try {
                await client.editMessage(target, {
                    message: statusMsg.id,
                    text: STRINGS.task.create_failed
                });
            } catch (editError) {
                log.warn("Failed to update external URL error message", { error: editError.message });
            }
            throw e;
        }
    }

    /**
     * 批量添加媒体组任务
     */
    static async addBatchTasks(target, messages, userId) {
        const { client, format, STRINGS, PRIORITY, TaskRepository, getMediaInfo, runBotTaskWithRetry } = getDeps();
        const log = getLog();
        const chatIdStr = (target?.userId ?? target?.chatId ?? target?.channelId ?? target?.id ?? target).toString();

        let statusMsg = await runBotTaskWithRetry(
            () => client.sendMessage(target, {
                message: format(STRINGS.task.batch_captured, { count: messages.length }),
                parseMode: "html"
            }),
            userId,
            { priority: PRIORITY.UI },
            false,
            10
        );

        // 使用状态消息 msgId 作为批量取消标识，需在消息发送后更新按钮
        try {
            const updatedMsg = await runBotTaskWithRetry(
                () => client.editMessage(target, {
                    message: statusMsg.id,
                    text: format(STRINGS.task.batch_captured, { count: messages.length }),
                    buttons: [Button.inline(STRINGS.task.cancel_btn, Buffer.from(`cancel_msg_confirm_${statusMsg.id}`))],
                    parseMode: "html"
                }),
                userId,
                { priority: PRIORITY.UI },
                false,
                3
            );
            if (updatedMsg) statusMsg = updatedMsg;
        } catch (e) {
            log.warn("Failed to add cancel button to batch message", e);
        }

        const tasksData = [];

        for (const msg of messages) {
            const taskId = randomUUID();
            const info = getMediaInfo(msg);

            tasksData.push({
                id: taskId,
                userId: userId.toString(),
                chatId: chatIdStr,
                msgId: statusMsg.id,
                sourceMsgId: msg.id,
                sourceType: TASK_SOURCE_TYPES.TELEGRAM_MEDIA,
                sourceRef: buildTelegramMediaSourceRef({ chatId: chatIdStr, messageId: msg.id }),
                fileName: info?.name,
                fileSize: info?.size
            });
        }

        let createdBatch = false;
        try {
            await TaskRepository.createBatch(tasksData);
            createdBatch = true;
            // 立即推送到 QStash 队列
            for (const data of tasksData) {
                const message = messages.find(m => m.id === data.sourceMsgId);
                if (message) {
                    const task = this._createTaskObject(data.id, data.userId, data.chatId, data.msgId, message);
                    task.isGroup = true;
                    await this._enqueueTask(task);
                }
            }
        } catch (e) {
            log.error("Batch task creation/enqueue failed", e);
            if (createdBatch) {
                await Promise.allSettled(tasksData.map(data =>
                    this._markTaskFailed(data.id, `Queue enqueue failed: ${e.message}`, 'addBatchTasks.enqueue_failed')
                ));
            }
            try {
                await client.editMessage(target, {
                    message: statusMsg.id,
                    text: STRINGS.task.create_failed
                });
            } catch (editError) {
                log.warn("Failed to update batch error message", { error: editError.message });
            }
            throw e;
        }
        log.info("Batch tasks created and enqueued", { count: messages.length, status: 'enqueued' });
    }

    /**
     * [私有] 标准化构造内存中的任务对象
     */
    static _createTaskObject(id, userId, chatId, msgId, message) {
        const { getMediaInfo } = getDeps();
        const info = getMediaInfo(message);
        return {
            id,
            userId: userId.toString(),
            chatId: chatId.toString(),
            msgId,
            message,
            sourceType: TASK_SOURCE_TYPES.TELEGRAM_MEDIA,
            fileName: info?.name || 'unknown',
            lastText: "",
            isCancelled: false
        };
    }

    static async _getTelegramClientLease(instanceCoordinator) {
        if (!instanceCoordinator) return null;

        if (typeof instanceCoordinator.getLockLease === 'function') {
            const lease = await instanceCoordinator.getLockLease(TELEGRAM_CLIENT_LOCK_KEY);
            if (lease) return lease;
        } else if (await instanceCoordinator.hasLock(TELEGRAM_CLIENT_LOCK_KEY, { logContention: false })) {
            const instanceId = instanceCoordinator.getInstanceId?.() || instanceCoordinator.instanceId || 'unknown';
            return { instanceId, leaseId: instanceId };
        }

        return null;
    }

    static async _acquireWebhookTaskLock(instanceCoordinator, taskId, phase, dbTask = null) {
        const lockAcquired = await instanceCoordinator.acquireTaskLock(taskId);
        if (!lockAcquired && this._canRecoverStaleTaskProcessingLock(dbTask)) {
            const released = await instanceCoordinator.releaseStaleTaskLock?.(taskId);
            if (released) {
                const retryAcquired = await instanceCoordinator.acquireTaskLock(taskId);
                if (retryAcquired) return true;
            }
        }

        if (!lockAcquired) {
            const log = getLog();
            log.info("Task processing lock busy, webhook will be retried", { taskId, phase });
            throw new TaskProcessingLockBusyError(taskId, phase);
        }
        return true;
    }

    static _canRecoverStaleTaskProcessingLock(dbTask) {
        if (!dbTask) return false;
        if (dbTask.claimed_by || dbTask.claim_lease_id) return false;
        return dbTask.status === TASK_STATUSES.QUEUED || dbTask.status === TASK_STATUSES.DOWNLOADED;
    }

    /**
     * [私 evasion] 发布任务到 QStash 下载队列
     */
    static async _enqueueTask(task) {
        const { queueService } = getDeps();
        const log = getLog();
        const taskPayload = {
            userId: task.userId,
            chatId: task.chatId,
            msgId: task.msgId,
            _meta: {
                triggerSource: TASK_QUEUE_TRIGGER_SOURCES.DIRECT_QSTASH,
                source: 'TaskManager._enqueueTask',
                queueAttempt: task.queueAttempt
            }
        };

        const result = await queueService.enqueueDownloadTask(task.id, taskPayload);
        this._assertQueuePublishResult(result, task.id, 'download');
        log.info("Task enqueued for download", {
            taskId: task.id,
            service: 'qstash',
            triggerSource: TASK_QUEUE_TRIGGER_SOURCES.DIRECT_QSTASH
        });
        return result;
    }

    /**
     * [私ia] 发布任务到 QStash 上传队列
     */
    static async _enqueueUploadTask(task) {
        const { queueService } = getDeps();
        const log = getLog();
        const result = await queueService.enqueueUploadTask(task.id, {
            userId: task.userId,
            chatId: task.chatId,
            msgId: task.msgId,
            localPath: task.localPath,
            _meta: {
                queueAttempt: task.queueAttempt
            }
        });
        this._assertQueuePublishResult(result, task.id, 'upload');
        log.info("Task enqueued for upload", { taskId: task.id, service: 'qstash' });
        return result;
    }

    static _resolveDownloadedTaskLocalPath(dbTask, config) {
        const sourceRef = parseTaskSourceRef(dbTask.source_ref);
        const fileName = dbTask.file_name || sourceRef?.fileName || dbTask.id;
        const localFileName = isExternalUrlTask(dbTask)
            ? buildExternalLocalFileName(dbTask.id, fileName)
            : path.basename(fileName);
        return path.join(config.downloadDir, localFileName);
    }

    static async _enqueueDownloadedTaskForUpload(dbTask, source) {
        const { config, TaskRepository } = getDeps();
        const log = getLog();
        const localPath = this._resolveDownloadedTaskLocalPath(dbTask, config);

        if (!fs.existsSync(localPath)) {
            const reset = await TaskRepository.transitionStatus(dbTask.id, TASK_EVENTS.RETRY, 'Local file missing during upload queue repair', {
                returnResult: true,
                allowNoop: true,
                source: `${source}.local_missing`
            });
            if (reset.blocked) {
                log.warn("Downloaded task upload repair could not reset missing local file", {
                    taskId: dbTask.id,
                    reason: reset.reason
                });
                return { success: true, statusCode: 200, message: "Ignored by task state machine" };
            }
            return { success: false, statusCode: 503, message: "Local file missing; task reset for download retry" };
        }

        const reset = await TaskRepository.transitionStatus(dbTask.id, TASK_EVENTS.RESET_UPLOAD, null, {
            returnResult: true,
            allowNoop: true,
            source
        });
        if (reset.blocked) {
            log.info("Downloaded task upload repair ignored by state machine", {
                taskId: dbTask.id,
                reason: reset.reason,
                status: reset.fromStatus || reset.latestStatus
            });
            return { success: true, statusCode: 200, message: "Ignored by task state machine" };
        }

        await this._enqueueUploadTask({
            id: dbTask.id,
            userId: dbTask.user_id,
            chatId: dbTask.chat_id,
            msgId: dbTask.msg_id,
            localPath,
            queueAttempt: reset.queueAttempt
        });
        log.info("Downloaded task re-enqueued for upload", {
            taskId: dbTask.id,
            source
        });
        return { success: true, statusCode: 200, message: "Upload task re-enqueued" };
    }

    static async _downloadWebhookRecoveryEvent(taskId) {
        const { TaskRepository } = getDeps();
        try {
            const latest = await TaskRepository.findById(taskId);
            if (latest?.status === TASK_STATUSES.DOWNLOADED) {
                return TASK_EVENTS.RESET_UPLOAD;
            }
        } catch (error) {
            getLog().warn("Unable to inspect task state for retryable download recovery", {
                taskId,
                error: error.message
            });
        }
        return TASK_EVENTS.RETRY;
    }

    static _assertQueuePublishResult(result, taskId, type) {
        if (result?.fallback || result?.error) {
            throw new Error(`Queue enqueue failed for ${type} task ${taskId}: ${result.error || 'fallback result'}`);
        }
    }

    static async _markTaskFailed(taskId, errorMessage, source) {
        const { TaskRepository } = getDeps();
        await TaskRepository.transitionStatus(taskId, TASK_EVENTS.FAIL, errorMessage, {
            allowNoop: true,
            source
        });
    }

    /**
     * 检查是否允许UI更新（节流控制）
     */
    static canUpdateUI() {
        const now = Date.now();
        const tracker = this.uiUpdateTracker;
        
        // 重置窗口
        if (now - tracker.windowStart > tracker.windowSize) {
            tracker.count = 0;
            tracker.windowStart = now;
        }
        
        // 检查是否超过限制
        if (tracker.count >= tracker.maxUpdates) {
            return false;
        }
        
        tracker.count++;
        return true;
    }

    /**
     * 批量更新排队中的 UI（带节流控制）
     */
    static async updateQueueUI() {
        const { format, STRINGS, updateStatus } = getDeps();
        // 获取快照以避免在循环中由于数组变动导致 index 越界
        const snapshot = [...this.waitingTasks];
        const maxTasks = Math.min(snapshot.length, 5);
        
        for (let i = 0; i < maxTasks; i++) {
            const task = snapshot[i];
            if (!task || task.isGroup) continue;

            const newText = format(STRINGS.task.queued, { rank: i + 1 });

            if (task.lastText !== newText && this.canUpdateUI()) {
                await updateStatus(task, newText);
                task.lastText = newText;
                // 添加延迟避免 API 限制，但使用更高效的 Promise.race 控制并发
                if (i < maxTasks - 1) { // 最后一次不需要延迟
                    await new Promise(resolve => setTimeout(resolve, 1200));
                }
            }
        }
    }

    /**
     * [私有] 错误分类函数 - 根据错误类型返回对应的 HTTP 状态码
     * @param {Error} error - 错误对象
     * @returns {number} HTTP 状态码
     */
    static _classifyError(error) {
        const msg = error?.message || String(error || '');
        const code = error?.code || '';
        const infrastructure = classifyInfrastructureError(error);
        if (infrastructure.retryable) return 503;
        
        // 任务不存在或无效参数 -> 404
        if (msg.includes('not found') || msg.includes('not found in database') || 
            msg.includes('Source msg missing') || msg.includes('Local file not found') ||
            msg.includes('invalid') || msg.includes('invalid task')) {
            return 404;
        }
        
        // Telegram 或网络超时 -> 503 (Service Unavailable)
        if (msg.includes('timeout') || msg.includes('TIMEOUT') || msg.includes('ETIMEDOUT') ||
            msg.includes('network') || msg.includes('Network') || 
            msg.includes('fetch failed') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') ||
            msg.includes('getaddrinfo') || msg.includes('rate limit') || msg.includes('429')) {
            return 503;
        }
        
        // Cache/锁相关 -> 503
        if (msg.includes('lock') || msg.includes('Lock') || 
            code === 'TASK_PROCESSING_LOCK_BUSY' ||
            msg.includes('cache') || msg.includes('Cache') || 
            msg.includes('kv') || msg.includes('KV') ||
            msg.includes('upstash') || msg.includes('Upstash') ||
            msg.includes('cloudflare') || msg.includes('Cloudflare')) {
            return 503;
        }
        
        // DB 操作失败 -> 500
        if (msg.includes('database') || msg.includes('Database') || 
            msg.includes('d1') || msg.includes('D1') || 
            msg.includes('sql') || msg.includes('SQL') ||
            msg.includes('batch') || msg.includes('update')) {
            return 500;
        }
        
        // 其他内部错误 -> 500
        return 500;
    }

    static _isRetryableInfrastructureError(error) {
        const msg = error?.message || '';
        if (error?.retryable === true) return true;
        if (isRetryableInfrastructureError(error)) return true;
        if (this._classifyError(error) === 503) return true;
        return /D1 HTTP 5\d\d/i.test(msg) ||
            /D1 HTTP 400 \\[7500\\]/i.test(msg) ||
            /D1 Error: Network connection lost/i.test(msg) ||
            /Network connection lost/i.test(msg);
    }

    /**
     * 处理下载 Webhook - QStash 事件驱动
     * @returns {Promise<{success: boolean, statusCode: number, message?: string}>}
     */
    static async handleDownloadWebhook(taskId) {
        const { instanceCoordinator, TaskRepository } = getDeps();
        const log = getLog();
        let didClaim = false;
        let lockAcquired = false;
        // Leader 状态校验：只有持有 telegram_client 锁的实例才能处理任务
        const leaderLease = await this._getTelegramClientLease(instanceCoordinator);
        if (!leaderLease) {
            return { success: false, statusCode: 503, message: "Service Unavailable - Not Leader" };
        }

        try {
            // 从数据库获取任务信息
            const dbTask = await TaskRepository.findById(taskId);
            log.debug(`QStash Received download webhook for Task: ${taskId}`, {
                taskId
            });
            if (!dbTask) {
                log.error(`❌ Task ${taskId} not found in database`);
                return { success: false, statusCode: 404, message: "Task not found" };
            }

            // 用户已取消：直接 ACK（防止 QStash 重试/继续处理）
            if (dbTask.status === TASK_STATUSES.CANCELLED) {
                log.info("Task cancelled, skipping download webhook", { taskId });
                return { success: true, statusCode: 200 };
            }

            if (dbTask.status === TASK_STATUSES.DOWNLOADED) {
                lockAcquired = await this._acquireWebhookTaskLock(instanceCoordinator, taskId, 'upload_queue_repair', dbTask);
                return await this._enqueueDownloadedTaskForUpload(dbTask, 'handleDownloadWebhook.upload_queue_repair');
            }

            lockAcquired = await this._acquireWebhookTaskLock(instanceCoordinator, taskId, 'download', dbTask);
            const claim = await TaskRepository.transitionStatus(taskId, TASK_EVENTS.START_DOWNLOAD, null, {
                claimedBy: leaderLease.instanceId,
                claimLeaseId: leaderLease.leaseId,
                returnResult: true,
                allowNoop: true,
                source: 'handleDownloadWebhook'
            });
            if (claim.blocked) {
                log.info("Download webhook ignored by state machine", { taskId, reason: claim.reason, status: claim.fromStatus || claim.latestStatus });
                return this._resolveBlockedWebhookResult('download', claim, dbTask.status);
            }
            didClaim = true;

            const resolvedSource = await resolveTaskSource(dbTask);
            const task = buildTaskObjectFromDb(dbTask, resolvedSource);
            task.processingLockHeld = true;
            attachClaimLease(task, leaderLease);

            // 检查是否属于组任务（通过 msgId 查询同组任务数量）
            try {
                const siblings = await TaskRepository.findByMsgId(dbTask.msg_id);
                if (siblings && siblings.length > 1) {
                    task.isGroup = true;
                }
            } catch (e) {
                log.warn(`Failed to check group status for task ${taskId}`, e);
            }

            // 执行下载逻辑
            if (isExternalUrlTask(task)) {
                await this.downloadExternalUrlTask(task);
            } else {
                await this.downloadTask(task);
            }
            return { success: true, statusCode: 200 };

        } catch (error) {
            if (isTaskProcessingLockBusyError(error)) {
                return { success: false, statusCode: 503, message: error.message };
            }
            log.error("Download webhook failed", { taskId, error });
            if (error?.code === 'TASK_SOURCE_MISSING') {
                await TaskRepository.transitionStatus(taskId, TASK_EVENTS.FAIL, error.message, {
                    ...(didClaim ? getClaimFenceOptions(leaderLease) : {}),
                    allowNoop: true,
                    source: 'handleDownloadWebhook.source_missing'
                });
                return { success: false, statusCode: 404, message: "Source message missing" };
            }
            const code = this._classifyError(error);
            if (this._isRetryableInfrastructureError(error)) {
                const recoveryEvent = await this._downloadWebhookRecoveryEvent(taskId);
                await this._resetAfterRetryableInfrastructureError(taskId, recoveryEvent, error, 'handleDownloadWebhook.retryable_infra_error', didClaim ? getClaimFenceOptions(leaderLease) : {});
                return { success: false, statusCode: code, message: error.message };
            }
            await TaskRepository.transitionStatus(taskId, TASK_EVENTS.FAIL, error.message, {
                ...(didClaim ? getClaimFenceOptions(leaderLease) : {}),
                allowNoop: true,
                source: 'handleDownloadWebhook.error'
            });
            return { success: false, statusCode: code, message: error.message };
        } finally {
            if (lockAcquired) {
                await instanceCoordinator.releaseTaskLock(taskId);
            }
        }
    }

    /**
     * 处理上传 Webhook - QStash 事件驱动
     * @returns {Promise<{success: boolean, statusCode: number, message?: string}>}
     */
     static async handleUploadWebhook(taskId) {
        const { instanceCoordinator, TaskRepository, config } = getDeps();
        const log = getLog();
        let didClaim = false;
        let lockAcquired = false;
        // Leader 状态校验：只有持有 telegram_client 锁 del 实例才能处理任务
        const leaderLease = await this._getTelegramClientLease(instanceCoordinator);
        if (!leaderLease) {
            return { success: false, statusCode: 503, message: "Service Unavailable - Not Leader" };
        }

        try {
            // 从数据库获取任务信息
            const dbTask = await TaskRepository.findById(taskId);
            log.debug(`QStash Received upload webhook for Task: ${taskId}`, {
                taskId
            });
            
            if (!dbTask) {
                log.error(`❌ Task ${taskId} not found in database`);
                return { success: false, statusCode: 404, message: "Task not found" };
            }

            // 用户已取消：直接 ACK（防止 QStash 重试/继续处理）
            if (dbTask.status === TASK_STATUSES.CANCELLED) {
                log.info("Task cancelled, skipping upload webhook", { taskId });
                return { success: true, statusCode: 200 };
            }

            lockAcquired = await this._acquireWebhookTaskLock(instanceCoordinator, taskId, 'upload', dbTask);
            const uploadStart = await TaskRepository.transitionStatus(taskId, TASK_EVENTS.START_UPLOAD, null, {
                claimedBy: leaderLease.instanceId,
                claimLeaseId: leaderLease.leaseId,
                returnResult: true,
                allowNoop: true,
                source: 'handleUploadWebhook'
            });
            if (uploadStart.blocked) {
                log.info("Upload webhook ignored by state machine", { taskId, reason: uploadStart.reason, status: uploadStart.fromStatus || uploadStart.latestStatus });
                return this._resolveBlockedWebhookResult('upload', uploadStart, dbTask.status);
            }
            didClaim = true;

            const sourceRef = parseTaskSourceRef(dbTask.source_ref);
            const localFileName = isExternalUrlTask(dbTask)
                ? buildExternalLocalFileName(taskId, dbTask.file_name || sourceRef?.fileName)
                : path.basename(dbTask.file_name);
            const localPath = path.join(config.downloadDir, localFileName);
            if (!fs.existsSync(localPath)) {
                await TaskRepository.transitionStatus(taskId, TASK_EVENTS.FAIL, 'Local file not found', {
                    ...getClaimFenceOptions(leaderLease),
                    allowNoop: true,
                    source: 'handleUploadWebhook.local_missing'
                });
                return { success: false, statusCode: 404, message: "Local file not found" };
            }

            const resolvedSource = resolveStoredTaskSource(dbTask);
            const task = buildTaskObjectFromDb(dbTask, resolvedSource);
            task.localPath = localPath;
            task.fileName = dbTask.file_name;
            task.processingLockHeld = true;
            attachClaimLease(task, leaderLease);

            // 检查是否属于组任务（通过 msgId 查询同组任务数量）
            try {
                const siblings = await TaskRepository.findByMsgId(dbTask.msg_id);
                if (siblings && siblings.length > 1) {
                    task.isGroup = true;
                }
            } catch (e) {
                log.warn(`Failed to check group status for upload task ${taskId}`, e);
            }

            // 执行上传逻辑
            await this.uploadTask(task);
            return { success: true, statusCode: 200 };

        } catch (error) {
            if (isTaskProcessingLockBusyError(error)) {
                return { success: false, statusCode: 503, message: error.message };
            }
            log.error("Upload webhook failed", { taskId, error });
            if (error?.code === 'TASK_SOURCE_MISSING') {
                await TaskRepository.transitionStatus(taskId, TASK_EVENTS.FAIL, error.message, {
                    ...(didClaim ? getClaimFenceOptions(leaderLease) : {}),
                    allowNoop: true,
                    source: 'handleUploadWebhook.source_missing'
                });
                return { success: false, statusCode: 404, message: "Source message missing" };
            }
            const code = this._classifyError(error);
            if (this._isRetryableInfrastructureError(error)) {
                await this._resetAfterRetryableInfrastructureError(taskId, TASK_EVENTS.RESET_UPLOAD, error, 'handleUploadWebhook.retryable_infra_error', didClaim ? getClaimFenceOptions(leaderLease) : {});
                return { success: false, statusCode: code, message: error.message };
            }
            await TaskRepository.transitionStatus(taskId, TASK_EVENTS.FAIL, error.message, {
                ...(didClaim ? getClaimFenceOptions(leaderLease) : {}),
                allowNoop: true,
                source: 'handleUploadWebhook.error'
            });
            return { success: false, statusCode: code, message: error.message };
        } finally {
            if (lockAcquired) {
                await instanceCoordinator.releaseTaskLock(taskId);
            }
        }
    }

    /**
     * 手动重试任务 - 实例无关，通过 QStash 重新派发
     * @param {string} taskId - 任务ID
     * @param {string|number} [userId] - 调用者ID（WebhookRouter 等内部调用可省略）
     * @returns {Promise<{success: boolean, statusCode: number, message?: string}>}
     */
    static async retryTask(taskId, userId) {
        const { TaskRepository, AuthGuard, instanceCoordinator, queueService } = getDeps();
        const log = getLog();

        if (!taskId) {
            return { success: false, statusCode: 400, message: "Task ID is required" };
        }

        try {
            const dbTask = await TaskRepository.findById(taskId);
            if (!dbTask) {
                return { success: false, statusCode: 404, message: "Task not found" };
            }

            // 权限校验：与 cancelTask 保持一致
            if (userId) {
                const isOwner = dbTask.user_id === userId.toString();
                const canRetryAny = await AuthGuard.can(userId, "task:cancel:any");
                if (!isOwner && !canRetryAny) {
                    return { success: false, statusCode: 403, message: "Permission denied" };
                }
            }

            if (dbTask.status === TASK_STATUSES.COMPLETED) {
                return { success: false, statusCode: 400, message: "Task already completed" };
            }

            if (dbTask.status === TASK_STATUSES.CANCELLED) {
                return { success: false, statusCode: 400, message: "Task is cancelled" };
            }

            if (!MANUAL_RETRY_ALLOWED_STATUS_SET.has(dbTask.status)) {
                return {
                    success: false,
                    statusCode: 409,
                    message: `Task is ${dbTask.status}; manual retry is only allowed for failed or queued tasks`
                };
            }

            // 只对 failed/queued 清理陈旧任务锁；活动态必须交给 claim lease 和恢复扫描处理。
            await instanceCoordinator.releaseTaskLock(taskId);

            const retryTransition = await TaskRepository.transitionStatus(taskId, TASK_EVENTS.RETRY, null, {
                returnResult: true,
                allowNoop: true,
                source: 'retryTask'
            });
            if (retryTransition.blocked) {
                return { success: false, statusCode: 409, message: retryTransition.reason || "Task cannot be retried" };
            }

            // 通过 QStash 重新派发；当 durable queue 暂时不可用时，和恢复扫描保持同一套
            // fail-open 策略：当前 Telegram leader 直接接管，任务仍以 D1 状态机为 SSOT。
            try {
                await queueService.enqueueDownloadTask(taskId, {
                    _meta: {
                        triggerSource: TASK_QUEUE_TRIGGER_SOURCES.MANUAL_RETRY,
                        queueAttempt: retryTransition.queueAttempt
                    }
                });
            } catch (enqueueError) {
                if (!this._isRetryableInfrastructureError(enqueueError)) {
                    throw enqueueError;
                }

                log.warn("Manual retry queue unavailable, falling back to local download handler", {
                    taskId,
                    reason: redactSensitiveText(enqueueError.message || String(enqueueError))
                });
                const fallbackResult = await this.handleDownloadWebhook(taskId);
                if (!fallbackResult?.success) {
                    return {
                        success: false,
                        statusCode: fallbackResult?.statusCode || 503,
                        message: fallbackResult?.message || "Task queued; local retry fallback unavailable"
                    };
                }
            }

            log.info(`Task ${taskId} re-enqueued for retry`);
            return { success: true, statusCode: 200, message: "Task re-enqueued" };
        } catch (error) {
            log.error(`Failed to retry task ${taskId}:`, error);
            return { success: false, statusCode: 500, message: error.message };
        }
    }

    static async _resetAfterRetryableInfrastructureError(taskId, event, error, source, claimFenceOptions = {}) {
        const { TaskRepository } = getDeps();
        const log = getLog();
        try {
            const result = await TaskRepository.transitionStatus(taskId, event, error.message, {
                ...claimFenceOptions,
                returnResult: true,
                allowNoop: true,
                source
            });
            if (result.blocked) {
                log.warn("Unable to reset task after retryable infrastructure error", {
                    taskId,
                    event,
                    reason: result.reason,
                    status: result.fromStatus || result.latestStatus,
                    error: error.message
                });
            }
            return result;
        } catch (resetError) {
            log.warn("Retryable infrastructure reset failed; leaving task for webhook retry", {
                taskId,
                event,
                error: error.message,
                resetError: resetError.message
            });
            return { changed: false, blocked: true, reason: resetError.message };
        }
    }

    /**
     * 处理媒体组批处理 Webhook - QStash 事件驱动
     * @returns {Promise<{success: boolean, statusCode: number, message?: string}>}
     */
    static async handleMediaBatchWebhook(groupId, taskIds) {
        const log = getLog();
        try {
            log.debug(`QStash Received media-batch webhook for Group: ${groupId}, TaskCount: ${taskIds.length}`);

            // 这里可以实现批处理逻辑，目前先逐个处理
            for (const taskId of taskIds) {
                const result = await this.handleDownloadWebhook(taskId);
                if (!result.success) {
                    // 如果任何一个失败，返回第一个错误
                    return result;
                }
            }
            return { success: true, statusCode: 200 };

        } catch (error) {
            log.error("Media batch webhook failed", { groupId, error });
            const code = this._classifyError(error);
            return { success: false, statusCode: code, message: error.message };
        }
    }

    /**
     * 下载Task - 负责MTProto下载阶段
     */
    static async downloadTask(task) {
        return downloadTask.call(this, task);
    }

    /**
     * 上传Task - 负责rclone转存阶段（无需MTProto）
     */
    static async uploadTask(task) {
        return uploadTask.call(this, task);
    }

    static async downloadExternalUrlTask(task) {
        return downloadExternalUrlTask.call(this, task);
    }

    /**
     * 取消指定任务
     */
    static async cancelTask(taskId, userId) {
        const { TaskRepository, AuthGuard, safeEdit, STRINGS } = getDeps();
        const dbTask = await TaskRepository.findById(taskId);
        if (!dbTask) return false;

        const isOwner = dbTask.user_id === userId.toString();
        const canCancelAny = await AuthGuard.can(userId, "task:cancel:any");

        if (!isOwner && !canCancelAny) return false;

        // 标记取消（用于中途快速拦截）
        this.cancelledTaskIds.add(taskId);

        // 检查下载队列
        const downloadTask = this.waitingTasks.find(t => t.id.toString() === taskId) ||
                            (this.currentTask && this.currentTask.id.toString() === taskId ? this.currentTask : null);

        if (downloadTask) {
            downloadTask.isCancelled = true;
            if (downloadTask.proc) downloadTask.proc.kill("SIGTERM");
            this.waitingTasks = this.waitingTasks.filter(t => t.id.toString() !== taskId);
        }

        // 检查上传队列
        const uploadTask = this.waitingUploadTasks.find(t => t.id.toString() === taskId);
        if (uploadTask) {
            uploadTask.isCancelled = true;
            if (uploadTask.proc) uploadTask.proc.kill("SIGTERM");
            this.waitingUploadTasks = this.waitingUploadTasks.filter(t => t.id.toString() !== taskId);
        }

        // 检查运行中任务（QStash / Webhook 驱动）
        const inFlight = this.inFlightTasks.get(taskId);
        if (inFlight) {
            inFlight.isCancelled = true;
            if (inFlight.proc) inFlight.proc.kill("SIGTERM");
        }

        const transition = await TaskRepository.transitionStatus(taskId, TASK_EVENTS.CANCEL, '用户手动取消', {
            returnResult: true,
            allowNoop: true,
            source: 'cancelTask'
        });
        if (transition.blocked) {
            this.cancelledTaskIds.delete(taskId);
            return false;
        }

        // 立即更新 UI（防止用户感觉“没反应”）
        try {
            let peer = dbTask.chat_id;
            if (typeof peer === 'string' && /^-?\d+$/.test(peer)) peer = BigInt(peer);
            await safeEdit(peer, parseInt(dbTask.msg_id), STRINGS.task.cancelled, null, userId, "html");
        } catch (e) {
            // safeEdit 内部已兜底，这里不再抛出
        }
        return true;
    }

    /**
     * 按 status 消息 msgId 取消整组任务（媒体组）
     */
    static async cancelTasksByMsgId(msgId, userId) {
        const { TaskRepository, AuthGuard, UIHelper, safeEdit } = getDeps();
        if (!msgId) return false;

        const tasks = await TaskRepository.findByMsgId(msgId);
        if (!tasks.length) return false;

        // 权限：任务属于自己或具备管理员权限
        const canCancelAny = await AuthGuard.can(userId, "task:cancel:any");
        const ownsAll = tasks.every(t => t.user_id === userId.toString());
        if (!ownsAll && !canCancelAny) return false;

        const results = await Promise.allSettled(tasks.map(t =>
            TaskRepository.transitionStatus(t.id, TASK_EVENTS.CANCEL, '用户手动取消', {
                returnResult: true,
                allowNoop: true,
                source: 'cancelTasksByMsgId'
            })
        ));
        const cancelledTaskIds = new Set();
        results.forEach((result, index) => {
            if (result.status !== 'fulfilled') return;
            if (!result.value?.blocked) {
                tasks[index].status = TASK_STATUSES.CANCELLED;
                cancelledTaskIds.add(tasks[index].id);
            }
        });
        if (cancelledTaskIds.size === 0) return false;

        for (const t of tasks.filter(task => cancelledTaskIds.has(task.id))) {
            this.cancelledTaskIds.add(t.id);
            const inFlight = this.inFlightTasks.get(t.id);
            if (inFlight) {
                inFlight.isCancelled = true;
                if (inFlight.proc) inFlight.proc.kill("SIGTERM");
            }
        }

        // 刷新批量看板 UI
        try {
            const meta = tasks[0];
            let peer = meta.chat_id;
            if (typeof peer === 'string' && /^-?\d+$/.test(peer)) peer = BigInt(peer);
            const focusTask = { id: meta.id };
            const { text } = UIHelper.renderBatchMonitor(tasks, focusTask, TASK_STATUSES.CANCELLED);
            await safeEdit(peer, parseInt(meta.msg_id), text, null, userId, "html");
        } catch (e) {
            // safeEdit 内部已兜底
        }

        return true;
    }

    static monitorLocks = new Map();
    static autoScalingInterval = null;

    /**
     * 启动自动缩放监控
     */
    static startAutoScaling() {
        if (this.autoScalingInterval) return;
        const log = getLog();
        import('../utils/limiter.js').then((limiterModule) => {
            this.autoScalingInterval = setInterval(() => {
                try {
                    const { botGlobalLimiter, mtprotoLimiter, mtprotoFileLimiter } = limiterModule;
                    if (botGlobalLimiter?.adjustConcurrency) botGlobalLimiter.adjustConcurrency();
                    if (mtprotoLimiter?.adjustConcurrency) mtprotoLimiter.adjustConcurrency();
                    if (mtprotoFileLimiter?.adjustConcurrency) mtprotoFileLimiter.adjustConcurrency();
                    
                    // Enforce queue size limits to prevent unbounded growth
                    this.enforceQueueSizeLimits();
                } catch (error) {
                    log.error('Auto-scaling adjustment error:', error);
                }
            }, 30000);
        });
    }

    /**
     * 停止自动缩放监控
     */
    static stopAutoScaling() {
        if (this.autoScalingInterval) {
            clearInterval(this.autoScalingInterval);
            this.autoScalingInterval = null;
        }
    }

    /**
     * [私有] 检查文件大小是否匹配（带动态容差）
     */
    static _isSizeMatch(size1, size2) {
        const diff = Math.abs(size1 - size2);
        const maxSize = Math.max(size1, size2);
        if (maxSize < 1024 * 1024) return diff < 10 * 1024;
        else if (maxSize < 100 * 1024 * 1024) return diff < 1024 * 1024;
        else return diff < 10 * 1024 * 1024;
    }

    /**
     * [私有] 刷新组任务看板 (智能节流)
     */
    static async _refreshGroupMonitor(task, status, downloaded = 0, total = 0, errorMsg = null) {
        const { TaskRepository, UIHelper, safeEdit } = getDeps();
        const msgId = task.msgId;
        const lastUpdate = this.monitorLocks.get(msgId) || 0;
        const now = Date.now();
        const isFinal = [TASK_STATUSES.COMPLETED, TASK_STATUSES.FAILED, TASK_STATUSES.CANCELLED].includes(status);

        if (now - lastUpdate < 2000 && !isFinal) return;
        this.monitorLocks.set(msgId, now);

        const groupTasks = await TaskRepository.findByMsgId(msgId);
        if (!groupTasks.length) return;

        const { text } = UIHelper.renderBatchMonitor(groupTasks, task, status, downloaded, total, errorMsg);

        let peer = task.chatId;
        if (typeof peer === 'string' && /^-?\d+$/.test(peer)) peer = BigInt(peer);

        await safeEdit(peer, parseInt(task.msgId), text, null, task.userId, "html");
    }

}
