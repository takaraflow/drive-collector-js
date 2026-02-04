import { vi, describe, it, expect, beforeEach } from "vitest";

const mockProvider = {
    getBindingSteps: vi.fn(),
    handleInput: vi.fn(),
};

const mockFactory = {
    isSupported: vi.fn(),
    create: vi.fn(),
    getSupportedTypes: vi.fn(),
};

const mockSession = {
    start: vi.fn(),
    update: vi.fn(),
    clear: vi.fn(),
};

const mockDriveRepo = {
    create: vi.fn(),
};

vi.mock("../../../src/services/drives/DriveProviderFactory.js", () => ({
    DriveProviderFactory: mockFactory,
}));

vi.mock("../../../src/modules/SessionManager.js", () => ({
    SessionManager: mockSession,
}));

vi.mock("../../../src/repositories/DriveRepository.js", () => ({
    DriveRepository: mockDriveRepo,
}));

vi.mock("../../../src/repositories/SettingsRepository.js", () => ({
    SettingsRepository: {
        set: vi.fn(),
        get: vi.fn(),
    },
}));

vi.mock("../../../src/services/logger/index.js", () => ({
    logger: {
        withModule: () => ({
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
        }),
    }
}));

const { BindingService } = await import("../../../src/services/drives/BindingService.js");

describe("BindingService", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("startBinding", () => {
        it("应该正确初始化绑定会话并使用冒号隔离符", async () => {
            mockFactory.isSupported.mockReturnValue(true);
            mockFactory.create.mockReturnValue(mockProvider);
            mockProvider.getBindingSteps.mockReturnValue([{ step: "STEP1", prompt: "p1" }]);

            const result = await BindingService.startBinding("user1", "google_drive");

            expect(result.success).toBe(true);
            expect(mockSession.start).toHaveBeenCalledWith("user1", "GOOGLE_DRIVE:STEP1");
        });
    });

    describe("handleInput", () => {
        it("应该支持新格式（冒号）并正确路由到 Provider", async () => {
            const session = { current_step: "GOOGLE_DRIVE:STEP1", temp_data: "{}" };
            mockFactory.isSupported.mockReturnValue(true);
            mockFactory.create.mockReturnValue(mockProvider);
            mockProvider.getBindingSteps.mockReturnValue([{ step: "STEP1" }]);
            mockProvider.handleInput.mockResolvedValue({ success: true, nextStep: "STEP2", data: { k: "v" } });

            const result = await BindingService.handleInput("user1", session, "my-token");

            expect(result.success).toBe(true);
            expect(mockSession.update).toHaveBeenCalledWith("user1", "GOOGLE_DRIVE:STEP2", { k: "v" });
        });

        it("应该支持旧格式（下划线）的向下兼容", async () => {
            const session = { current_step: "GOOGLE_DRIVE_STEP1", temp_data: "{}" };
            mockFactory.getSupportedTypes.mockReturnValue(["google_drive"]);
            mockFactory.isSupported.mockReturnValue(true);
            mockFactory.create.mockReturnValue(mockProvider);
            mockProvider.getBindingSteps.mockReturnValue([{ step: "STEP1" }]);
            mockProvider.handleInput.mockResolvedValue({ success: true, data: { user: "test" } });

            await BindingService.handleInput("user1", session, "input");

            expect(mockDriveRepo.create).toHaveBeenCalledWith("user1", expect.any(String), "google_drive", expect.any(Object));
        });
    });
});
