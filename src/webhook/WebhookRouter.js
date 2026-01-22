import { queueService } from '../services/QueueService.js';
import { TaskManager } from '../processor/TaskManager.js';
import { logger } from '../services/logger/index.js';

const log = logger.withModule ? logger.withModule('WebhookRouter') : logger;

let appReady = false;

export function setAppReadyState(value) {
    appReady = Boolean(value);
}

/**
 * 处理健康检查请求
 */
function handleHealthChecks(req, res) {
    const healthPath = '/health';
    const healthzPath = '/healthz';
    const readyPath = '/ready';
    const hostHeader = req.headers?.host || req.headers?.[':authority'] || 'localhost';
    const url = new URL(req.url, `http://${hostHeader}`);
    const path = url.pathname;

    if ((req.method === 'GET' || req.method === 'HEAD') && req.url) {
        try {
            if ([healthPath, healthzPath, readyPath].includes(path)) {
                // 检查应用就绪状态
                if (path === readyPath && !appReady) {
                    res.writeHead(503);
                    res.end(req.method === 'HEAD' ? '' : 'Not Ready');
                    return true;
                }

                // 增强健康检查：验证业务模块是否运行
                // 注意：这里使用 global 访问 AppInitializer 实例，或者通过其他方式获取状态
                // 为了简单起见，我们假设 AppInitializer 会在 global 上注册状态
                const businessRunning = global.appInitializer?.businessModulesRunning !== false;
                
                if (!businessRunning) {
                    log.warn(`⚠️ 健康检查失败: 业务模块未运行 (Path: ${path})`);
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

    // 1. 处理文件流 (Worker 端)
    if (path.startsWith('/api/v2/stream/') && req.method === 'POST') {
        const taskId = path.split('/').pop();
        const { streamTransferService } = await import("../services/StreamTransferService.js");
        const result = await streamTransferService.handleIncomingChunk(taskId, req);
        res.writeHead(result.statusCode || 200);
        res.end(result.success ? 'OK' : (result.message || 'Error'));
        return true;
    }

    // 2. 处理状态更新 (Leader 端)
    if (path.startsWith('/api/v2/tasks/') && path.endsWith('/status') && req.method === 'POST') {
        const parts = path.split('/');
        const taskId = parts[parts.length - 2];
        
        let body = '';
        for await (const chunk of req) {
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
        for await (const chunk of req) {
            body += chunk;
        }
        
        // 认证检查
        const secret = req.headers['x-instance-secret'];
        const { getConfig } = await import("../config/index.js");
        const config = getConfig();
        if (secret !== config.streamForwarding.secret) {
            res.writeHead(401);
            res.end('Unauthorized');
            return true;
        }
        
        const { type = 'auto' } = JSON.parse(body || '{}');
        const result = await TaskManager.retryTask(taskId, type);
        
        res.writeHead(result.statusCode || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return true;
    }

    // 4. 触发配置刷新 (Webhook)
    if (path === '/api/v2/config/refresh' && req.method === 'POST') {
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
        log.warn("❌ 无效的JSON格式", { body: body?.substring?.(0, 200) || 'empty', error: error.message });
        res.writeHead(400);
        res.end('Invalid JSON');
        return { result: { success: false, statusCode: 400 }, data: null, path };
    }

    // 详细 metadata 记录和触发源校验
    const _meta = data._meta || {};
    const triggerSource = _meta.triggerSource || 'unknown';
    const instanceId = _meta.instanceId || 'unknown';
    const groupId = data.groupId || _meta.groupId || 'unknown';
    const timestamp = _meta.timestamp || Date.now();

    log.info(`📩 收到 Webhook: ${path}`, { 
        taskId: data.taskId, 
        groupId,
        triggerSource, 
        instanceId,
        timestamp,
        isFromQStash: triggerSource === 'direct-qstash',
        metadata: _meta
    });

    let result = { success: true, statusCode: 200 };

    if (path.endsWith('/download')) {
        result = await TaskManager.handleDownloadWebhook(data.taskId);
    } else if (path.endsWith('/upload')) {
        result = await TaskManager.handleUploadWebhook(data.taskId);
    } else if (path.endsWith('/batch')) {
        result = await TaskManager.handleMediaBatchWebhook(data.groupId, data.taskIds);
    } else if (path.endsWith('/system-events')) {
        if (data.event === 'media_group_flush' && data.gid) {
            const mediaGroupBufferModule = await import("../services/MediaGroupBuffer.js");
            const mediaGroupBuffer = mediaGroupBufferModule.default;
            await mediaGroupBuffer.handleFlushEvent(data);
        }
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
    const isNotLeader503 =
        result?.statusCode === 503 &&
        typeof result?.message === 'string' &&
        result.message.includes('Not Leader');

    const alreadyForwarded = Boolean(req.headers?.['x-forwarded-by-instance']);

    if (isNotLeader503 && !alreadyForwarded) {
        const resolveWebhookLeaderUrl = async () => {
            try {
                const [{ cache }, { instanceCoordinator }] = await Promise.all([
                    import("../services/CacheService.js"),
                    import("../services/InstanceCoordinator.js")
                ]);

                const lockData = await cache.get('lock:telegram_client', 'json', { skipL1: true });
                const leaderInstanceId = lockData?.instanceId;
                if (!leaderInstanceId) return null;

                const activeInstances = (await instanceCoordinator.getActiveInstances?.()) || [];
                const leaderInstance = activeInstances.find(i => i.id === leaderInstanceId);
                const baseUrl = leaderInstance?.tunnelUrl || leaderInstance?.url;
                if (!baseUrl) return null;
                return String(baseUrl).replace(/\/$/, '');
            } catch (error) {
                log.warn('Failed to resolve webhook leader URL', { error: error?.message || String(error) });
                return null;
            }
        };

        const forwardWebhookToLeader = async ({ targetBaseUrl, requestPath, signature, bodyString }) => {
            const { instanceCoordinator } = await import("../services/InstanceCoordinator.js");
            const targetUrl = `${targetBaseUrl}${requestPath}`;
            const forwardHeaders = {
                'upstash-signature': signature,
                'content-type': 'application/json',
                'x-forwarded-by-instance': instanceCoordinator.instanceId || 'unknown'
            };

            return fetch(targetUrl, {
                method: 'POST',
                headers: forwardHeaders,
                body: bodyString,
                signal: AbortSignal.timeout(15000)
            });
        };

        const hostHeader = req.headers?.host || req.headers?.[':authority'] || 'localhost';
        const url = new URL(req.url, `http://${hostHeader}`);
        const targetBaseUrl = await resolveWebhookLeaderUrl();
        if (targetBaseUrl) {
            log.info('➡️ Forwarding webhook to leader', {
                path,
                targetBaseUrl,
                taskId: data.taskId,
                groupId: data.groupId || data._meta?.groupId,
                triggerSource: data._meta?.triggerSource,
                instanceId: data._meta?.instanceId
            });

            const forwardedResponse = await forwardWebhookToLeader({
                targetBaseUrl,
                requestPath: `${url.pathname}${url.search}`,
                signature: req.headers['upstash-signature'],
                bodyString: body
            });

            const upstreamStatus = forwardedResponse.status;
            if (forwardedResponse.ok) {
                log.info('✅ Webhook forwarded to leader', { path, upstreamStatus, targetBaseUrl });
                res.writeHead(200);
                res.end('OK');
                return true;
            }

            const upstreamBody = await forwardedResponse.text();
            log.warn('⚠️ Webhook forward returned non-2xx', {
                path,
                upstreamStatus,
                targetBaseUrl,
                upstreamBodyPreview: upstreamBody?.substring?.(0, 200) || ''
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
    if (await handleStreamForwarding(req, res)) return;

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
        const bodyPreview = body ? body.substring(0, 200) : 'empty';
        log.warn("⚠️ QStash 签名验证失败", {
            signature: signature || 'missing',
            bodyPreview: bodyPreview,
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