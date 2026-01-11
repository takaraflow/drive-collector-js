import { vi } from 'vitest';

const fixedTime = 1700000000000;

const applyFakeClock = () => {
    vi.useFakeTimers();
    vi.setSystemTime(fixedTime);
};

// Apply fake clock immediately so setup hooks see deterministic time
applyFakeClock();

export const setupTimeMocks = () => {
    applyFakeClock();
};

export const cleanupTimeMocks = () => {
    vi.clearAllTimers();
    vi.setSystemTime(fixedTime);
};

export const mockDateNow = () => Date.now();
export { fixedTime };
