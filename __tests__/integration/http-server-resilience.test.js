describe("HTTP Server Resilience", () => {
    let indexContent;

    beforeAll(async () => {
        const fs = await import('fs/promises');
        const path = await import('path');
        const indexPath = path.resolve(process.cwd(), 'index.js');
        indexContent = await fs.readFile(indexPath, 'utf-8');
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
