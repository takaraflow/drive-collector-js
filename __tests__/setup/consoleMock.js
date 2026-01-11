import { vi } from 'vitest';

const originalConsole = global.console;

// Global console mock for all tests
const mockConsole = {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
};

// Apply the mock immediately so setup files and global hooks see it
global.console = mockConsole;

beforeEach(() => {
    vi.clearAllMocks();
});

export const restoreConsole = () => {
    global.console = originalConsole;
    return originalConsole;
};

export { originalConsole as nativeConsole };
