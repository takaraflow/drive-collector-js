const fs = require('fs');
const content = fs.readFileSync('__tests__/unit/utils/lifecycle.test.js', 'utf8');

const targetMock = `            await mediaGroupBufferPersistHook[0]();

            expect(console.error).toHaveBeenCalledWith('❌ MediaGroupBuffer 持久化失败:', expect.any(Error));
            console.error = originalConsoleError;`;

const fixedMock = `            await mediaGroupBufferPersistHook[0]();

            const { logger } = await import("../../../src/services/logger/index.js");
            expect(logger.withModule('Lifecycle').error).toHaveBeenCalledWith('❌ MediaGroupBuffer 持久化失败:', expect.any(Error));
            console.error = originalConsoleError;`;

fs.writeFileSync('__tests__/unit/utils/lifecycle.test.js', content.replace(targetMock, fixedMock));
console.log("Mock patched");
