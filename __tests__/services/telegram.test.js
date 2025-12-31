import { jest } from "@jest/globals";

// Mock the telegram module
jest.mock("telegram", () => ({
    TelegramClient: jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        start: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        on: jest.fn(),
        addEventHandler: jest.fn(),
        getMe: jest.fn().mockResolvedValue({ id: 123 }),
        session: { save: jest.fn().mockReturnValue("mock_session") },
        connected: true,
        _sender: { disconnect: jest.fn().mockResolvedValue(undefined) }
    })),
    Api: { messages: { GetHistory: jest.fn() } }
}));

jest.mock("telegram/sessions/index.js", () => ({
    StringSession: jest.fn().mockImplementation((sessionString) => ({
        save: jest.fn().mockReturnValue(sessionString || "mock_session")
    }))
}));

jest.mock("../../src/config/index.js", () => ({
    config: {
        apiId: 123,
        apiHash: "mock_hash",
        botToken: "mock_token",
        telegram: { proxy: { host: "proxy.example.com", port: "1080", type: "socks5", username: "proxy_user", password: "proxy_pass" } }
    }
}));

jest.mock("../../src/repositories/SettingsRepository.js", () => ({
    SettingsRepository: {
        get: jest.fn().mockResolvedValue(""),
        set: jest.fn().mockResolvedValue(undefined)
    }
}));

jest.mock("../../src/services/InstanceCoordinator.js", () => ({
    instanceCoordinator: {
        hasLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(undefined)
    }
}));

describe("Telegram Service", () => {
    let client;
    let module;

    beforeAll(async () => {
        jest.useFakeTimers();
        module = await import("../../src/services/telegram.js");
        client = module.client;
    });

    afterAll(async () => {
        jest.useRealTimers();
        if (module.stopWatchdog) {
            module.stopWatchdog();
        }
    });

    test("should export client and related functions", () => {
        expect(client).toBeDefined();
        expect(module.getClient).toBeDefined();
        expect(module.reconnectBot).toBeDefined();
        expect(module.startWatchdog).toBeDefined();
        expect(module.stopWatchdog).toBeDefined();
    });

    test("should handle basic client operations", async () => {
        const clientInstance = await module.getClient();
        expect(clientInstance.connect).toBeDefined();
        expect(clientInstance.start).toBeDefined();
        expect(clientInstance.getMe).toBeDefined();
    });
});