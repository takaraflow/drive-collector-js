import { jest } from '@jest/globals';

const originalConsole = global.console;

// Global console mock for all tests
const mockConsole = {
    log: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
};

// Apply the mock immediately so setup files and global hooks see it
global.console = mockConsole;

beforeEach(() => {
    jest.clearAllMocks();
});

export const restoreConsole = () => {
    global.console = originalConsole;
    return originalConsole;
};

export { originalConsole as nativeConsole };
