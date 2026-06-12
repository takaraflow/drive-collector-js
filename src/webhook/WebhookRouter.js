import { queueService } from '../services/QueueService.js';
import { TaskManager } from '../processor/TaskManager.js';
import { logger } from '../services/logger/index.js';
import { resolveInstanceBaseUrl } from '../utils/instanceUrl.js';
import { getBuildIdentity, getPublicBuildIdentity } from '../utils/buildIdentity.js';
import { parseTaskQueuePayload, TASK_QUEUE_TRIGGER_SOURCES } from '../domain/task-queue-contract.js';
import { CACHE_KEYS } from '../domain/cache-keys.js';
import crypto from 'node:crypto';

const log = logger.withModule ? logger.withModule('WebhookRouter') : logger;

let appReady = false;

export function setAppReadyState(value) {
    appReady = Boolean(value);
}

function hasValidInstanceSecret(headerSecret, configuredSecret) {
    if (typeof headerSecret !== 'string' || typeof configuredSecret !== 'string') {
        return false;
    }

    const header = headerSecret.trim();
    const secret = configuredSecret.trim();
    if (header === '' || secret === '') return false;

    try {
        const headerHash = crypto.createHash('sha256').update(header).digest();
        const secretHash = crypto.createHash('sha256').update(secret).digest();
        return crypto.timingSafeEqual(headerHash, secretHash);
    } catch {
        return false;
    }
}

function isInstanceSecretAuthorized(req, cfg) {
    return hasValidInstanceSecret(req.headers?.['x-instance-secret'], cfg?.streamForwarding?.secret);
}

function getOptionalRuntimeConfig() {
    try {
        return global.appInitializer?.config || null;
    } catch {
        return null;
    }
}

function getVersionResponseIdentity(req) {
    const identity = getBuildIdentity();
    return isInstanceSecretAuthorized(req, getOptionalRuntimeConfig())
        ? identity
        : getPublicBuildIdentity(identity);
}

function isNotTelegramLeaderResult(result) {
    return result?.statusCode === 503 &&
        typeof result?.message === 'string' &&
        result.message.includes('Not Leader');
}

async function resolveTelegramLeaderBaseUrl() {
    try {
        const [{ cache }, { instanceCoordinator }] = await Promise.all([
            import("../services/CacheService.js"),
            import("../services/InstanceCoordinator.js")
        ]);

        const lockData = await cache.get(CACHE_KEYS.telegramClientLock(), 'json', { skipCache: true });
        const leaderInstanceId = lockData?.instanceId;
        if (!leaderInstanceId) return null;

        const activeInstances = (await instanceCoordinator.getActiveInstances?.({ strong: true })) || [];
        const leaderInstance = activeInstances.find(i => i.id === leaderInstanceId);
        const baseUrl = resolveInstanceBaseUrl(leaderInstance);
        if (!baseUrl) return null;

        return String(baseUrl).replace(/\/$/, '');
    } catch (error) {
        log.warn('Failed to resolve Telegram leader URL', { error: error?.message || String(error) });
        return null;
    }
}

async function forwardPostToTelegramLeader(req, targetBaseUrl, requestPath, headers, bodyString) {
    const { instanceCoordinator } = await import("../services/InstanceCoordinator.js");
    return fetch(`${targetBaseUrl}${requestPath}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...headers,
            'x-forwarded-by-instance': instanceCoordinator.instanceId || 'unknown'
        },
        body: bodyString || '',
        signal: AbortSignal.timeout(15000)
    });
}

function getRequestPath(req) {
    const hostHeader = req.headers?.host || req.headers?.[':authority'] || 'localhost';
    const url = new URL(req.url, `http://${hostHeader}`);
    return `${url.pathname}${url.search}`;
}

/**
 * 处理健康检查请求
 */
function handleHealthChecks(req, res) {
    const healthPath = '/health';
    const healthzPath = '/healthz';
    const readyPath = '/ready';
    const versionPath = '/version';
    const hostHeader = req.headers?.host || req.headers?.[':authority'] || 'localhost';
    const url = new URL(req.url, `http://${hostHeader}`);
    const path = url.pathname;

    if ((req.method === 'GET' || req.method === 'HEAD') && req.url) {
        try {
            if ([healthPath, healthzPath, readyPath, versionPath].includes(path)) {
                if (path === versionPath) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(req.method === 'HEAD' ? '' : JSON.stringify(getVersionResponseIdentity(req)));
                    return true;
                }

                if (path === healthPath || path === healthzPath) {
                    res.writeHead(200);
                    res.end(req.method === 'HEAD' ? '' : 'OK');
                    return true;
                }

                // 检查应用就绪状态
                if (!appReady) {
                    res.writeHead(503);
                    res.end(req.method === 'HEAD' ? '' : 'Not Ready');
                    return true;
                }

                // Readiness is the traffic gate; liveness only proves the process can answer HTTP.
                const businessRunning = global.appInitializer?.businessModulesRunning !== false;
                
                if (!businessRunning) {
                    log.warn(`⚠️ 就绪检查失败: 业务模块未运行 (Path: ${path})`);
                    res.writeHead(503);
                    res.end(req.method === 'HEAD' ? '' : 'Service Unavailable: Business Modules Down');
                    return true;
                }

                res.writeHead(200);
                res.end(req.method === 'HEAD' ? '' : 'OK');
                return true;
            }
        } catch (e) {
            res.writeHead(500);
            res.end('Internal Server Error');
            return true;
        }
    }
    return false;
}

/**
 * 处理流式转发API V2
 */
async function handleStreamForwarding(req, res) {
    const hostHeader = req.headers?.host || req.headers?.[':authority'] || 'localhost';
    const url = new URL(req.url, `http://${hostHeader}`);
    const path = url.pathname;

    // Stream control routes (require x-instance-secret auth)
    if (path.startsWith('/api/v2/stream/')) {
        const { getConfig } = await import("../config/index.js");
        const cfg = getConfig();

        // Check for specific action routes first (progress, full-progress, resume, reset)
        const streamPathMatch = path.match(/^\/api\/v2\/stream\/([^\/]+)\/(progress|full-progress|resume|reset)$/);
        if (streamPathMatch) {
            // All sub-routes require secret auth
            if (!isInstanceSecretAuthorized(req, cfg)) {
                res.writeHead(401);
                res.end('Unauthorized');
                return true;
            }

            const taskId = streamPathMatch[1];
            const action = streamPathMatch[2];
            const { streamTransferService } = await import("../services/StreamTransferService.js");

            // GET /api/v2/stream/:taskId/progress
            if (action === 'progress' && req.method === 'GET') {
                const progress = streamTransferService.getTaskProgress(taskId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ lastChunkIndex: progress }));
                return true;
            }

            // GET /api/v2/stream/:taskId/full-progress
            if (action === 'full-progress' && req.method === 'GET') {
                const fullProgress = await streamTransferService.getTaskFullProgress(taskId);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(fullProgress));
                return true;
            }

            // POST /api/v2/stream/:taskId/resume
            if (action === 'resume' && req.method === 'POST') {
                let body = '';
                for await (const chunk of req) { body += chunk; }
                let parsed = {};
                try { parsed = JSON.parse(body); } catch {}
                const result = await streamTransferService.resumeTask(taskId, parsed);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
                return true;
            }

            // DELETE /api/v2/stream/:taskId/reset
            if (action === 'reset' && req.method === 'DELETE') {
                const result = await streamTransferService.resetTask(taskId, null, {
                    ownerInstanceId: req.headers?.['x-stream-owner-instance-id'] || null,
                    requireOwnerHeader: true
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
                return true;
            }
        }

        // POST /api/v2/stream/:taskId — incoming chunk (secret check inside handleIncomingChunk)
        if (req.method === 'POST') {
            if (!isInstanceSecretAuthorized(req, cfg)) {
                res.writeHead(401);
                res.end('Unauthorized');
                return true;
            }

            const taskId = path.split('/').pop();
            const { streamTransferService } = await import("../services/StreamTransferService.js");
            const result = await streamTransferService.handleIncomingChunk(taskId, req);
            res.writeHead(result.statusCode || 200);
            res.end(result.success ? 'OK' : (result.message || 'Error'));
            return true;
        }
    }

    // 2. 处理状态更新 (Leader 端)
    if (path.startsWith('/api/v2/tasks/') && path.endsWith('/status') && req.method === 'POST') {
        const parts = path.split('/');
        const taskId = parts[parts.length - 2];
        const { getConfig } = await import("../config/index.js");
        const config = getConfig();
        if (!isInstanceSecretAuthorized(req, config)) {
            res.writeHead(401);
            res.end('Unauthorized');
            return true;
        }

        let body = '';
        let bodySize = 0;
        for await (const chunk of req) {
            bodySize += chunk.length;
            if (bodySize > 1024 * 1024) {
                res.writeHead(413);
                res.end('Payload Too Large');
                return true;
            }
            body += chunk;
        }

        const { streamTransferService } = await import("../services/StreamTransferService.js");
        const result = await streamTransferService.handleStatusUpdate(taskId, JSON.parse(body), req.headers);
        res.writeHead(result.statusCode || 200);
        res.end(result.success ? 'OK' : (result.message || 'Error'));
        return true;
    }

    // 3. 手动重试任务
    if (path.startsWith('/api/v2/tasks/') && path.endsWith('/retry') && req.method === 'POST') {
        const parts = path.split('/');
        const taskId = parts[parts.length - 2];

        let body = '';
        let bodySize = 0;
        for await (const chunk of req) {
            bodySize += chunk.length;
            if (bodySize > 1024 * 1024) {
                res.writeHead(413);
                res.end('Payload Too Large');
                return true;
            }
            body += chunk;
        }
        
        // 认证检查
        const { getConfig } = await import("../config/index.js");
        const config = getConfig();
        if (!isInstanceSecretAuthorized(req, config)) {
            res.writeHead(401);
            res.end('Unauthorized');
            return true;
        }
        
        const result = await TaskManager.retryTask(taskId);
        if (isNotTelegramLeaderResult(result) && !req.headers?.['x-forwarded-by-instance']) {
            const targetBaseUrl = await resolveTelegramLeaderBaseUrl();
            if (targetBaseUrl) {
                log.debug('➡️ Forwarding manual retry to Telegram leader', {
                    taskId,
                    targetBaseUrl
                });
                const forwardedResponse = await forwardPostToTelegramLeader(
                    req,
                    targetBaseUrl,
                    getRequestPath(req),
                    { 'x-instance-secret': config.streamForwarding.secret },
                    body
                );
                const upstreamBody = await forwardedResponse.text();
                res.writeHead(forwardedResponse.status || 503, { 'Content-Type': 'application/json' });
                res.end(upstreamBody || JSON.stringify({
                    success: false,
                    statusCode: forwardedResponse.status || 503,
                    message: 'Telegram leader retry returned an empty response'
                }));
                return true;
            }
        }
        
        res.writeHead(result.statusCode || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return true;
    }

    // 4. 触发配置刷新 (Webhook)
    if (path === '/api/v2/config/refresh' && req.method === 'POST') {
        const { getConfig } = await import("../config/index.js");
        const cfg = getConfig();
        if (!isInstanceSecretAuthorized(req, cfg)) {
            res.writeHead(401);
            res.end('Unauthorized');
            return true;
        }
        const { refreshConfiguration } = await import("../config/index.js");
        const result = await refreshConfiguration();
        res.writeHead(result.success ? 200 : 500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return true;
    }

    return false;
}

/**
 * 解析webhook数据并处理
 */
async function processWebhookData(req, res, signature, body) {
    const hostHeader = req.headers?.host || req.headers?.[':authority'] || 'localhost';
    const url = new URL(req.url, `http://${hostHeader}`);
    const path = url.pathname;
    
    // 处理无效JSON
    let data;
    try {
        data = JSON.parse(body);
    } catch (error) {
        log.warn("❌ 无效的JSON格式", {
            bodyBytes: Buffer.byteLength(body || ''),
            error: error.message
        });
        return {
            result: { success: false, statusCode: 400, message: 'Invalid JSON' },
            data: null,
            path
        };
    }

    const payload = parseTaskQueuePayload(data);
    const groupId = payload.groupId || 'unknown';

    log.debug(`📩 收到 Webhook: ${path}`, {
        taskId: payload.taskId,
        groupId,
        triggerSource: payload.meta.triggerSource,
        instanceId: payload.meta.instanceId,
        timestamp: payload.meta.timestamp,
        isFromQStash: payload.meta.triggerSource === TASK_QUEUE_TRIGGER_SOURCES.DIRECT_QSTASH,
        metadata: payload.meta
    });

    let result = { success: true, statusCode: 200 };

    if (path.endsWith('/download')) {
        result = await TaskManager.handleDownloadWebhook(payload.taskId);
    } else if (path.endsWith('/upload')) {
        result = await TaskManager.handleUploadWebhook(payload.taskId);
    } else if (path.endsWith('/batch')) {
        result = await TaskManager.handleMediaBatchWebhook(payload.groupId, data.taskIds);
    } else if (path.endsWith('/system-events')) {
        if (data.event === 'media_group_flush' && data.gid) {
            const mediaGroupBufferModule = await import("../services/MediaGroupBuffer.js");
            const mediaGroupBuffer = mediaGroupBufferModule.default;
            await mediaGroupBuffer.handleFlushEvent(data);
        }
        result = { success: true, statusCode: 200 };
    } else if (path.endsWith('/state_sync')) {
        const { stateSynchronizer } = await import("../services/StateSynchronizer.js");
        await stateSynchronizer.handleSyncEvent(data);
        result = { success: true, statusCode: 200 };
    } else if (path.endsWith('/cache_sync')) {
        const { consistentCache } = await import("../services/ConsistentCache.js");
        await consistentCache.handleSyncEvent(data);
        result = { success: true, statusCode: 200 };
    } else {
        log.warn(`❓ 未知的 Webhook 路径: ${path}`);
    }

    return { result, data, path };
}

/**
 * 处理webhook转发到leader实例
 */
async function handleWebhookForwarding(req, res, result, data, path, body) {
    const alreadyForwarded = Boolean(req.headers?.['x-forwarded-by-instance']);

    if (isNotTelegramLeaderResult(result) && !alreadyForwarded) {
        const targetBaseUrl = await resolveTelegramLeaderBaseUrl();
        if (targetBaseUrl) {
            log.debug('➡️ Forwarding webhook to leader', {
                path,
                targetBaseUrl,
                taskId: data.taskId,
                groupId: data.groupId || data._meta?.groupId,
                triggerSource: data._meta?.triggerSource,
                instanceId: data._meta?.instanceId
            });

            const forwardedResponse = await forwardPostToTelegramLeader(
                req,
                targetBaseUrl,
                getRequestPath(req),
                { 'upstash-signature': req.headers['upstash-signature'] },
                body
            );

            const upstreamStatus = forwardedResponse.status;
            if (forwardedResponse.ok) {
                log.debug('✅ Webhook forwarded to leader', { path, upstreamStatus, targetBaseUrl });
                res.writeHead(200);
                res.end('OK');
                return true;
            }

            const upstreamBody = await forwardedResponse.text();
            log.warn('⚠️ Webhook forward returned non-2xx', {
                path,
                upstreamStatus,
                targetBaseUrl,
                upstreamBodyBytes: Buffer.byteLength(upstreamBody || '')
            });
            res.writeHead(upstreamStatus || 503);
            res.end(upstreamBody || 'Error');
            return true;
        }
    }
    return false;
}

/**
 * Webhook 处理程序 (供外部 HTTP Server 或测试使用)
 */
export async function handleWebhook(req, res) {
    // 处理健康检查
    if (handleHealthChecks(req, res)) return;

    // 检查应用是否就绪
    if (!appReady) {
        res.writeHead(503);
        res.end('Not Ready');
        return;
    }

    // 处理流式转发API
    try {
        if (await handleStreamForwarding(req, res)) return;
    } catch (streamError) {
        console.error("❌ Stream forwarding error:", streamError);
        res.writeHead(500);
        res.end('Internal Server Error');
        return;
    }

    // 验证签名
    const signature = req.headers['upstash-signature'];
    if (!signature) {
        res.writeHead(401);
        res.end('Unauthorized');
        return;
    }

    // 获取请求体
    let body = '';
    for await (const chunk of req) {
        body += chunk;
    }

    // 验证签名
    const isValid = await queueService.verifyWebhookSignature(signature, body);
    if (!isValid) {
        log.warn("⚠️ QStash 签名验证失败", {
            signaturePresent: Boolean(signature),
            bodyBytes: Buffer.byteLength(body || ''),
            url: req.url,
            method: req.method
        });
        res.writeHead(401);
        res.end('Unauthorized');
        return;
    }

    try {
        // 解析和处理webhook数据
        const { result, data, path } = await processWebhookData(req, res, signature, body);

        // 处理webhook转发
        if (await handleWebhookForwarding(req, res, result, data, path, body)) return;

        // 返回最终结果
        res.writeHead(result.statusCode || 200);
        res.end(result.success ? 'OK' : (result.message || 'Error'));

    } catch (error) {
        console.error("❌ Request handling error:", error);
        res.writeHead(500);
        res.end('Internal Server Error');
    }
}
