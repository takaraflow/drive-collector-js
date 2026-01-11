// Move http mock to top level for ESM
const mockServer = {
    listen: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    close: vi.fn(cb => { if (cb) cb(); return mockServer; })
};

vi.mock("http", () => ({
    default: {
        createServer: vi.fn(() => mockServer)
    },
    createServer: vi.fn(() => mockServer)
}));

// Mock QueueService
const mockVerifySignature = vi.fn().mockResolvedValue(true);
const mockQueueService = {
    verifyWebhookSignature: mockVerifySignature
};

// Mock TaskManager
const mockHandleDownloadWebhook = vi.fn();
const mockHandleUploadWebhook = vi.fn();
const mockHandleMediaBatchWebhook = vi.fn();

const mockTaskManager = {
    handleDownloadWebhook: mockHandleDownloadWebhook,
    handleUploadWebhook: mockHandleUploadWebhook,
    handleMediaBatchWebhook: mockHandleMediaBatchWebhook
};

// Mock telegram client to avoid initialization
const mockClient = {};
vi.mock("../../src/services/telegram.js", () => ({
    client: mockClient
}));

// Mock modules
vi.mock("../../src/services/QueueService.js", () => ({
    queueService: mockQueueService
}));

vi.mock("../../src/processor/TaskManager.js", () => ({
    TaskManager: mockTaskManager
}));

describe("QStash Webhook Integration", () => {
    let handleQStashWebhook;

    beforeAll(async () => {
        // Mock process methods to prevent exit
        const originalExit = process.exit;
        process.exit = vi.fn();

        // Import the handler function and mock all dependencies
        vi.mock("../../src/services/telegram.js", () => ({
            client: mockClient,
            stopWatchdog: vi.fn(),
            startWatchdog: vi.fn()
        }));

        vi.mock("../../src/services/QueueService.js", () => ({
            queueService: mockQueueService
        }));

        vi.mock("../../src/processor/TaskManager.js", () => ({
            TaskManager: {
                handleDownloadWebhook: mockHandleDownloadWebhook,
                handleUploadWebhook: mockHandleUploadWebhook,
                handleMediaBatchWebhook: mockHandleMediaBatchWebhook
            }
        }));

        vi.mock("../../src/services/InstanceCoordinator.js", () => ({
            instanceCoordinator: {
                start: vi.fn().mockResolvedValue(undefined),
                stop: vi.fn().mockResolvedValue(undefined)
            }
        }));

        vi.mock("../../src/repositories/SettingsRepository.js", () => ({
            SettingsRepository: {
                get: vi.fn().mockResolvedValue("0"),
                set: vi.fn().mockResolvedValue(undefined)
            }
        }));

        vi.mock("../../src/services/d1.js", () => ({
            d1: {
                batch: vi.fn().mockResolvedValue(undefined)
            }
        }));

        vi.mock("../../src/dispatcher/bootstrap.js", () => ({
            startDispatcher: vi.fn()
        }));

        vi.mock("../../src/processor/bootstrap.js", () => ({
            startProcessor: vi.fn(),
            stopProcessor: vi.fn()
        }));

        vi.mock("../../src/repositories/DriveRepository.js", () => ({
            DriveRepository: {
                findAll: vi.fn().mockResolvedValue([])
            }
        }));

        vi.mock("../../src/services/rclone.js", () => ({
            CloudTool: {
                listRemoteFiles: vi.fn().mockResolvedValue([])
            }
        }));

        vi.mock("../../src/services/logger.js", () => ({
            logger: {
                info: vi.fn(),
                error: vi.fn(),
                warn: vi.fn(),
                debug: vi.fn()
            }
        }));

        // Mock initConfig before importing index.js
        vi.mock("../../src/config/index.js", () => ({
            config: {
                qstash: {
                    token: "mock-token",
                    url: "https://qstash.upstash.io",
                    webhookUrl: "https://example.com/webhook"
                },
                telegram: {
                    proxy: {}
                }
            },
            initConfig: vi.fn().mockResolvedValue({}),
            validateConfig: vi.fn().mockReturnValue(true),
            getConfig: vi.fn().mockReturnValue({
                qstash: {
                    token: "mock-token",
                    url: "https://qstash.upstash.io",
                    webhookUrl: "https://example.com/webhook"
                },
                telegram: {
                    proxy: {}
                }
            })
        }));

        // Now import index.js
        const { handleQStashWebhook: webhookHandler } = await import("../../index.js");
        handleQStashWebhook = webhookHandler;

        // Restore process.exit
        process.exit = originalExit;
    });

    afterAll(async () => {
        // Clean up any timers or connections
        try {
            const { stopWatchdog } = await import("../../src/services/telegram.js");
            if (stopWatchdog) stopWatchdog();
        } catch (e) {
            // Ignore
        }
        
        // Clear any pending timers
        const timers = Object.keys(global).filter(k => k.startsWith('_'));
        timers.forEach(timer => {
            if (global[timer] && typeof global[timer].unref === 'function') {
                global[timer].unref();
            }
        });
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mockVerifySignature.mockResolvedValue(true);
        // Set up default successful returns for TaskManager methods
        mockHandleDownloadWebhook.mockResolvedValue({ success: true, statusCode: 200 });
        mockHandleUploadWebhook.mockResolvedValue({ success: true, statusCode: 200 });
        mockHandleMediaBatchWebhook.mockResolvedValue({ success: true, statusCode: 200 });
    });

    const createMockRequest = (url, body = {}, headers = {}) => {
        const bodyString = JSON.stringify(body);
        const req = {
            url,
            headers: {
                'upstash-signature': 'v1=test_signature',
                ...headers
            },
            method: 'POST'
        };

        // Mock async iterator for request body
        req[Symbol.asyncIterator] = async function* () {
            yield Buffer.from(bodyString);
        };

        return req;
    };

    const createMockResponse = () => {
        const res = {
            writeHead: vi.fn(),
            end: vi.fn()
        };
        return res;
    };

    test("应当正确处理 download Webhook", async () => {
        const req = createMockRequest('/api/tasks/download', { taskId: '123' });
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(mockVerifySignature).toHaveBeenCalledWith('v1=test_signature', JSON.stringify({ taskId: '123' }));
        expect(mockHandleDownloadWebhook).toHaveBeenCalledWith('123');
        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalledWith('OK');
    });

    test("应当正确处理 upload Webhook", async () => {
        const req = createMockRequest('/api/tasks/upload', { taskId: '456' });
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(mockHandleUploadWebhook).toHaveBeenCalledWith('456');
        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalledWith('OK');
    });

    test("应当正确处理 batch Webhook", async () => {
        const req = createMockRequest('/api/tasks/batch', { groupId: 'group1', taskIds: ['1', '2'] });
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(mockHandleMediaBatchWebhook).toHaveBeenCalledWith('group1', ['1', '2']);
        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalledWith('OK');
    });

    test("应当正确处理 system-events Webhook", async () => {
        const req = createMockRequest('/api/tasks/system-events', { event: 'test', data: 'value' });
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalledWith('OK');
    });

    test("应当返回健康检查响应", async () => {
        const req = {
            url: '/health',
            method: 'GET',
            headers: {}
        };
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(mockVerifySignature).not.toHaveBeenCalled();
        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalledWith('OK');
    });

    test("应当拒绝非法签名", async () => {
        mockVerifySignature.mockResolvedValue(false);

        const req = createMockRequest('/api/tasks/download', { taskId: '123' });
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(mockVerifySignature).toHaveBeenCalled();
        expect(res.writeHead).toHaveBeenCalledWith(401);
        expect(res.end).toHaveBeenCalledWith('Unauthorized');
        expect(mockHandleDownloadWebhook).not.toHaveBeenCalled();
    });

    test("应当处理无效 JSON", async () => {
        const req = {
            url: '/api/tasks/download',
            headers: { 'upstash-signature': 'v1=test' },
            method: 'POST'
        };

        // Invalid JSON body
        req[Symbol.asyncIterator] = async function* () {
            yield Buffer.from('invalid json');
        };

        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(500);
        expect(res.end).toHaveBeenCalledWith('Internal Server Error');
    });

    test("应当处理下游处理异常", async () => {
        mockHandleDownloadWebhook.mockRejectedValue(new Error('Database error'));

        const req = createMockRequest('/api/tasks/download', { taskId: '123' });
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(mockHandleDownloadWebhook).toHaveBeenCalledWith('123');
        expect(res.writeHead).toHaveBeenCalledWith(500);
        expect(res.end).toHaveBeenCalledWith('Internal Server Error');
    });

    test("应当警告未知 topic", async () => {
        const req = createMockRequest('/api/tasks/unknown-topic', { data: 'test' });
        const res = createMockResponse();

        await handleQStashWebhook(req, res);

        expect(res.writeHead).toHaveBeenCalledWith(200);
        expect(res.end).toHaveBeenCalledWith('OK');
    });
});
