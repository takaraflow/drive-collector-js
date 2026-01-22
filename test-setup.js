import { vi } from 'vitest';

// ⚠️ CRITICAL: Mock process.nextTick IMMEDIATELY, before any test modules are loaded
// This ensures ALL tests use the mocked version, even if they import modules that use process.nextTick
const originalNextTick = process.nextTick;
process.nextTick = (callback) => {
    // Use vi.nextTick to integrate with fake timers
    return vi.nextTick(callback);
};

// Global test setup to ensure fake timers are used consistently
// All tests now use fake timers by default in beforeEach
beforeEach(() => {
    // Enable fake timers for every test, including Date.now()
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
});

// Global helper to advance timers
global.advanceTimersByTime = (ms) => {
    vi.advanceTimersByTime(ms);
};

// Global helper to run all pending timers
global.runAllTimers = () => {
    vi.runAllTimers();
};

// Global helper to run all timers and promises
global.flushPromises = () => {
    // Run all timers - vi.runAllTimers() automatically flushes microtasks
    vi.runAllTimers();
};

// Helper to flush all pending microtasks (promises, queueMicrotask, etc.)
global.flushMicrotasks = () => {
    // Run all timers which also flushes microtasks
    vi.runAllTimers();
};

// Clean up after each test - only clear mocks and timers, don't restore real timers
afterEach(() => {
    vi.clearAllTimers();
    vi.restoreAllMocks();
});
