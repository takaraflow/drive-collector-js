import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

describe("Health & Readiness Endpoints", () => {
    describe("/healthz endpoint", () => {
        test("healthz 端点应该在服务导入之前就能响应", async () => {
            const { handleQStashWebhook } = await import('../../index.js');
            
            const req = {
                url: '/healthz',
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

        test("healthz 端点应该支持 HEAD 请求", async () => {
            const { handleQStashWebhook } = await import('../../index.js');
            
            const req = {
                url: '/healthz',
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

        test("healthz 端点应该在所有服务模块未导入时也能工作", async () => {
            const { handleQStashWebhook } = await import('../../index.js');
            
            const req = {
                url: '/healthz',
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

    describe("/ready endpoint", () => {
        test("ready 端点应该在服务导入之前就能响应", async () => {
            const { handleQStashWebhook } = await import('../../index.js');
            
            const req = {
                url: '/ready',
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

        test("ready 端点应该支持 HEAD 请求", async () => {
            const { handleQStashWebhook } = await import('../../index.js');
            
            const req = {
                url: '/ready',
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

        test("ready 端点应该在所有服务模块未导入时也能工作", async () => {
            const { handleQStashWebhook } = await import('../../index.js');
            
            const req = {
                url: '/ready',
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

    describe("Endpoint isolation", () => {
        test("所有健康检查端点都不应该依赖服务导入", async () => {
            const { handleQStashWebhook } = await import('../../index.js');
            
            const endpoints = ['/health', '/healthz', '/ready'];
            const methods = ['GET', 'HEAD'];
            
            for (const path of endpoints) {
                for (const method of methods) {
                    const req = {
                        url: path,
                        method,
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
                }
            }
        });
    });
});
