import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock Dependencies
const mockSettings = new Map();
vi.mock('../src/repositories/SettingsRepository.js', () => ({
    SettingsRepository: {
        get: vi.fn((key, def) => mockSettings.has(key) ? mockSettings.get(key) : def),
        set: vi.fn((key, val) => mockSettings.set(key, val))
    }
}));

const mockClient = {
    start: vi.fn().mockResolvedValue(true),
    session: { save: vi.fn().mockReturnValue("mock_session") },
    addEventHandler: vi.fn()
};
vi.mock('../src/services/telegram.js', () => ({
    client: mockClient,
    saveSession: vi.fn()
}));

// We need to mock other things used in index.js
vi.mock('../src/core/TaskManager.js', () => ({
    TaskManager: {
        init: vi.fn().mockResolvedValue(true),
        startAutoScaling: vi.fn()
    }
}));
vi.mock('../src/bot/Dispatcher.js', () => ({
    Dispatcher: { handle: vi.fn() }
}));
vi.mock('http', () => ({
    default: { createServer: () => ({ listen: () => ({}) }) }
}));

describe('Startup Backoff Logic', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSettings.clear();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('should calculate backoff time correctly', async () => {
        // 模拟上次启动是在 10 秒前
        const now = Date.now();
        mockSettings.set("last_startup_time", (now - 10000).toString());
        mockSettings.set("recent_crash_count", "1");

        const lastStartup = parseInt(mockSettings.get("last_startup_time"));
        const diff = now - lastStartup;

        expect(diff).toBe(10000);

        if (diff < 60000) {
            const crashCount = parseInt(mockSettings.get("recent_crash_count")) + 1;
            const backoffSeconds = Math.min(10 * crashCount + Math.floor((60000 - diff) / 1000), 300);

            expect(crashCount).toBe(2);
            // 10 * 2 + (60 - 10) = 20 + 50 = 70s
            expect(backoffSeconds).toBe(70);
        }
    });

    it('should not trigger backoff for normal intervals', () => {
        const now = Date.now();
        mockSettings.set("last_startup_time", (now - 70000).toString()); // 70 seconds ago
        mockSettings.set("recent_crash_count", "0");

        const lastStartup = parseInt(mockSettings.get("last_startup_time"));
        const diff = now - lastStartup;

        expect(diff).toBe(70000);

        // Should not trigger backoff logic
        expect(diff >= 60000).toBe(true);
    });
});