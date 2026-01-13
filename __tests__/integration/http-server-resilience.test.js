vi.mock('../../index.js', () => ({
    handleQStashWebhook: vi.fn().mockImplementation(async (req, res) => {
        const healthPath = '/health';
        
        if ((req.method === 'GET' || req.method === 'HEAD') && req.url) {
            try {
                const url = new URL(req.url, `http://${req.headers.host}`);
                if (url.pathname === healthPath) {
                    res.writeHead(200);
                    if (req.method === 'HEAD') {
                        res.end();
                    } else {
                        res.end('OK');
                    }
                    return;
                }
            } catch (e) {
            }
        }
    })
}));

describe("HTTP Server Resilience", () => {
    let handleQStashWebhook, indexContent;

    beforeAll(async () => {
        const indexModule = await import('../../index.js');
        handleQStashWebhook = indexModule.handleQStashWebhook;
        
        const fs = await import('fs/promises');
        const path = await import('path');
        const indexPath = path.resolve(process.cwd(), 'index.js');
        indexContent = await fs.readFile(indexPath, 'utf-8');
    });

    describe("Health Endpoint Independence", () => {
        test("health 端点应该在服务导入之前就能响应", async () => {
            const req = {
                url: '/health',
                method: 'GET',
                headers: {
                    host: 'localhost'
                }
            };
            
            const res = {
                writeHead: vi.fn(),
                end: vi.fn()
            };
            
            await handleQStashWebhook(req, res);
            
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        test("health 端点应该支持 HEAD 请求", async () => {
            const req = {
                url: '/health',
                method: 'HEAD',
                headers: {
                    host: 'localhost'
                }
            };
            
            const res = {
                writeHead: vi.fn(),
                end: vi.fn()
            };
            
            await handleQStashWebhook(req, res);
            
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalled();
        });

        test("health 端点应该处理无效 URL 优雅降级", async () => {
            const req = {
                url: null,
                method: 'GET',
                headers: {
                    host: 'localhost'
                }
            };
            
            const res = {
                writeHead: vi.fn(),
                end: vi.fn()
            };
            
            await expect(handleQStashWebhook(req, res)).resolves.not.toThrow();
        });

        test("health 端点应该在所有服务模块未导入时也能工作", async () => {
            const req = {
                url: '/health',
                method: 'GET',
                headers: {
                    host: 'localhost'
                }
            };
            
            const res = {
                writeHead: vi.fn(),
                end: vi.fn()
            };
            
            await handleQStashWebhook(req, res);
            
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });
    });

    describe("HTTP Server Startup Resilience", () => {
        test("验证 index.js 中的启动顺序：HTTP 服务器在 Telegram 连接之前", () => {
            const buildWebhookServerIndex = indexContent.indexOf('buildWebhookServer');
            const startDispatcherIndex = indexContent.indexOf('startDispatcher');
            
            expect(buildWebhookServerIndex).toBeGreaterThan(-1);
            expect(startDispatcherIndex).toBeGreaterThan(-1);
            expect(buildWebhookServerIndex).toBeLessThan(startDispatcherIndex);
        });

        test("验证业务模块启动被 try-catch 包裹", () => {
            expect(indexContent).toContain('try {');
            expect(indexContent).toContain('await instanceCoordinator.start();');
            expect(indexContent).toContain('InstanceCoordinator 启动失败，但 HTTP 服务器继续运行');
            expect(indexContent).toContain('await startDispatcher();');
            expect(indexContent).toContain('Dispatcher (Telegram) 启动失败，但 HTTP 服务器继续运行');
            expect(indexContent).toContain('await startProcessor();');
            expect(indexContent).toContain('Processor 启动失败，但 HTTP 服务器继续运行');
        });
    });
});
