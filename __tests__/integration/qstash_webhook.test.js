import { jest } from "@jest/globals";

// Move http mock to top level for ESM
const mockServer = {
    listen: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
    close: jest.fn(cb => { if (cb) cb(); return mockServer; })
};

jest.unstable_mockModule("http", () => ({
    default: {
        createServer: jest.fn(() => mockServer)
    },
    createServer: jest.fn(() => mockServer)
}));

// Mock QueueService
const mockVerifySignature = jest.fn().mockResolvedValue(true);
const mockQueueService = {
    verifyWebhookSignature: mockVerifySignature
};

// Mock TaskManager
const mockHandleDownloadWebhook = jest.fn();
const mockHandleUploadWebhook = jest.fn();
const mockHandleMediaBatchWebhook = jest.fn();

const mockTaskManager = {
    handleDownloadWebhook: mockHandleDownloadWebhook,
    handleUploadWebhook: mockHandleUploadWebhook,
    handleMediaBatchWebhook: mockHandleMediaBatchWebhook
};

// Mock telegram client to avoid initialization
const mockClient = {};
jest.mock("../../src/services/telegram.js", () => ({
    client: mockClient
}));

// Mock modules
jest.unstable_mockModule("../../src/services/QueueService.js", () => ({
    queueService: mockQueueService
}));

jest.unstable_mockModule("../../src/processor/TaskManager.js", () => ({
    TaskManager: mockTaskManager
}));

describe("QStash Webhook Integration", () => {
    let handleQStashWebhook;

    beforeAll(async () => {
        // Mock process methods to prevent exit
        const originalExit = process.exit;
        process.exit = jest.fn();

        // Import the handler function and mock all dependencies
        jest.unstable_mockModule("../../src/services/telegram.js", () => ({
            client: mockClient,
            stopWatchdog: jest.fn(),
            startWatchdog: jest.fn()
        }));

        jest.unstable_mockModule("../../src/services/QueueService.js", () => ({
            queueService: mockQueueService
        }));

        jest.unstable_mockModule("../../src/processor/TaskManager.js", () => ({
            TaskManager: {
                handleDownloadWebhook: mockHandleDownloadWebhook,
                handleUploadWebhook: mockHandleUploadWebhook,
                handleMediaBatchWebhook: mockHandleMediaBatchWebhook
            }
        }));

        jest.unstable_mockModule("../../src/services/InstanceCoordinator.js", () => ({
            instanceCoordinator: {
                start: jest.fn().mockResolvedValue(undefined),
                stop: jest.fn().mockResolvedValue(undefined)
            }
        }));

        jest.unstable_mockModule("../../src/repositories/SettingsRepository.js", () => ({
            SettingsRepository: {
                get: jest.fn().mockResolvedValue("0"),
                set: jest.fn().mockResolvedValue(undefined)
            }
        }));

        jest.unstable_mockModule("../../src/services/d1.js", () => ({
            d1: {
                batch: jest.fn().mockResolvedValue(undefined)
            }
        }));

        jest.unstable_mockModule("../../src/dispatcher/bootstrap.js", () => ({
            startDispatcher: jest.fn()
        }));

        jest.unstable_mockModule("../../src/processor/bootstrap.js", () => ({
            startProcessor: jest.fn(),
            stopProcessor: jest.fn()
        }));

        jest.unstable_mockModule("../../src/repositories/DriveRepository.js", () => ({
            DriveRepository: {
                findAll: jest.fn().mockResolvedValue([])
            }
        }));

        jest.unstable_mockModule("../../src/services/rclone.js", () => ({
            CloudTool: {
                listRemoteFiles: jest.fn().mockResolvedValue([])
            }
        }));

        jest.unstable_mockModule("../../src/services/logger.js", () => ({
            logger: {
                info: jest.fn(),
                error: jest.fn(),
                warn: jest.fn(),
                debug: jest.fn()
            }
        }));

        // Mock initConfig before importing index.js
        jest.unstable_mockModule("../../src/config/index.js", () => ({
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
            initConfig: jest.fn().mockResolvedValue({}),
            validateConfig: jest.fn().mockReturnValue(true),
            getConfig: jest.fn().mockReturnValue({
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
        jest.clearAllMocks();
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
            writeHead: jest.fn(),
            end: jest.fn()
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
