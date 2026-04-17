const fs = require('fs');
const content = fs.readFileSync('__tests__/unit/utils/lifecycle.test.js', 'utf8');

const targetMock = `vi.mock('../../../src/services/logger/index.js', () => ({
    flushLogBuffer: vi.fn(),
}));`;

const fixedMock = `vi.mock('../../../src/services/logger/index.js', () => ({
    flushLogBuffer: vi.fn(),
    logger: {
        withModule: vi.fn().mockReturnValue({
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn()
        })
    }
}));`;

fs.writeFileSync('__tests__/unit/utils/lifecycle.test.js', content.replace(targetMock, fixedMock));
console.log("Mock patched");
