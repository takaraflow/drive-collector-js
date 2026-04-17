const fs = require('fs');
const content = fs.readFileSync('__tests__/unit/utils/lifecycle.test.js', 'utf8');

const targetMock = `            const mediaGroupBufferModule = await import("../../../src/services/MediaGroupBuffer.js");
            mediaGroupBufferModule.default.persist.mockRejectedValueOnce(new Error('Persist failed'));

            await registerShutdownHooks();
            const hooks = gracefulShutdown.register.mock.calls;
            const mediaGroupBufferPersistHook = hooks.find(call => call[2] === 'media-group-buffer-persist');`;

const fixedMock = `            await registerShutdownHooks();
            const hooks = gracefulShutdown.register.mock.calls;
            const mediaGroupBufferPersistHook = hooks.find(call => call[2] === 'media-group-buffer-persist');

            const mediaGroupBufferModule = await import("../../../src/services/MediaGroupBuffer.js");
            mediaGroupBufferModule.default.persist.mockRejectedValueOnce(new Error('Persist failed'));`;

fs.writeFileSync('__tests__/unit/utils/lifecycle.test.js', content.replace(targetMock, fixedMock));
console.log("Mock patched");
