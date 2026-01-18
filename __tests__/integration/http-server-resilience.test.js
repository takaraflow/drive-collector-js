describe("HTTP Server Resilience", () => {
    let indexContent;

    beforeAll(async () => {
        const fs = await import('fs/promises');
        const path = await import('path');
        const indexPath = path.resolve(process.cwd(), 'index.js');
        indexContent = await fs.readFile(indexPath, 'utf-8');
    });

    describe("HTTP Server Startup Resilience", () => {
        test("验证 index.js 中的启动顺序：HTTP 服务器在业务模块之前", () => {
            const httpServerStartIndex = indexContent.indexOf('httpServer.start()');
            const appInitializerStartIndex = indexContent.indexOf('appInitializer.start()');
            
            expect(httpServerStartIndex).toBeGreaterThan(-1);
            expect(appInitializerStartIndex).toBeGreaterThan(-1);
            expect(httpServerStartIndex).toBeLessThan(appInitializerStartIndex);
        });

        test("验证业务模块启动被 try-catch 包裹", () => {
            expect(indexContent).toContain('try {');
            expect(indexContent).toContain('await appInitializer.start();');
            expect(indexContent).toContain('} catch (error) {');
            expect(indexContent).toContain('console.error("💀 引导程序失败:", error);');
        });
    });
});
