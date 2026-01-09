import { jest } from '@jest/globals';

const fixedTime = 1700000000000;

const applyFakeClock = () => {
    jest.useFakeTimers();
    jest.setSystemTime(fixedTime);
};

// Apply fake clock immediately so setup hooks see deterministic time
applyFakeClock();

export const setupTimeMocks = () => {
    applyFakeClock();
};

export const cleanupTimeMocks = () => {
    jest.clearAllTimers();
    jest.setSystemTime(fixedTime);
};

export const mockDateNow = () => Date.now();
export { fixedTime };
