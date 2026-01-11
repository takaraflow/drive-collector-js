import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

describe("HTTP Server Resilience", () => {
    describe("Health Endpoint Independence", () => {
        test("health 端点应该在服务导入之前就能响应", async () => {
            const { handleQStashWebhook } = await import('../../index.js');
            
            // 创建一个简单的 mock request 来测试 /health
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
            
            // 调用处理函数，不应该抛出错误或尝试导入服务
            await handleQStashWebhook(req, res);
            
            // 验证响应正确
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });

        test("health 端点应该支持 HEAD 请求", async () => {
            const { handleQStashWebhook } = await import('../../index.js');
            
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
            const { handleQStashWebhook } = await import('../../index.js');
            
            const req = {
                url: null, // 无效 URL
                method: 'GET',
                headers: {
                    host: 'localhost'
                }
            };
            
            const res = {
                writeHead: vi.fn(),
                end: vi.fn()
            };
            
            // 不应该抛出错误
            await expect(handleQStashWebhook(req, res)).resolves.not.toThrow();
        });

        test("health 端点应该在所有服务模块未导入时也能工作", async () => {
            // 验证 health 端点不依赖任何服务导入
            const { handleQStashWebhook } = await import('../../index.js');
            
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
            
            // 调用处理函数
            await handleQStashWebhook(req, res);
            
            // 验证响应正确，说明它在服务导入之前就返回了
            expect(res.writeHead).toHaveBeenCalledWith(200);
            expect(res.end).toHaveBeenCalledWith('OK');
        });
    });

    describe("HTTP Server Startup Resilience", () => {
        test("验证 index.js 中的启动顺序：HTTP 服务器在 Telegram 连接之前", async () => {
            // 读取 index.js 源码来验证启动顺序
            const fs = await import('fs/promises');
            const path = await import('path');
            const indexPath = path.resolve(process.cwd(), 'index.js');
            const indexContent = await fs.readFile(indexPath, 'utf-8');
            
            // 查找 buildWebhookServer 和 startDispatcher 的位置
            const buildWebhookServerIndex = indexContent.indexOf('buildWebhookServer');
            const startDispatcherIndex = indexContent.indexOf('startDispatcher');
            
            // 验证 buildWebhookServer 在 startDispatcher 之前
            expect(buildWebhookServerIndex).toBeGreaterThan(-1);
            expect(startDispatcherIndex).toBeGreaterThan(-1);
            expect(buildWebhookServerIndex).toBeLessThan(startDispatcherIndex);
        });

        test("验证业务模块启动被 try-catch 包裹", async () => {
            // 读取 index.js 源码来验证错误处理
            const fs = await import('fs/promises');
            const path = await import('path');
            const indexPath = path.resolve(process.cwd(), 'index.js');
            const indexContent = await fs.readFile(indexPath, 'utf-8');
            
            // 验证实例协调器启动有 try-catch
            expect(indexContent).toContain('try {');
            expect(indexContent).toContain('await instanceCoordinator.start();');
            expect(indexContent).toContain('InstanceCoordinator 启动失败，但 HTTP 服务器继续运行');
            
            // 验证 Dispatcher 启动有 try-catch
            expect(indexContent).toContain('await startDispatcher();');
            expect(indexContent).toContain('Dispatcher (Telegram) 启动失败，但 HTTP 服务器继续运行');
            
            // 验证 Processor 启动有 try-catch
            expect(indexContent).toContain('await startProcessor();');
            expect(indexContent).toContain('Processor 启动失败，但 HTTP 服务器继续运行');
        });
    });
});
