import { vi, describe, it, expect, beforeEach } from "vitest";

// Mocks must come before imports
vi.mock("../../../src/services/drives/DriveProviderFactory.js", () => ({
    DriveProviderFactory: {
        isSupported: vi.fn(),
        create: vi.fn(),
        getSupportedTypes: vi.fn(),
    },
}));

vi.mock("../../../src/modules/SessionManager.js", () => ({
    SessionManager: {
        start: vi.fn(),
        update: vi.fn(),
        clear: vi.fn(),
    },
}));

vi.mock("../../../src/repositories/DriveRepository.js", () => ({
    DriveRepository: {
        create: vi.fn(),
        delete: vi.fn(),
        setDefaultDrive: vi.fn(),
    },
}));

vi.mock("../../../src/services/logger/index.js", () => ({
    logger: {
        withModule: () => ({
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn(),
        }),
    },
}));

// Import the mocked modules and the BindingService
import { DriveProviderFactory } from "../../../src/services/drives/DriveProviderFactory.js";
import { SessionManager } from "../../../src/modules/SessionManager.js";
import { DriveRepository } from "../../../src/repositories/DriveRepository.js";
import { BindingService } from "../../../src/services/drives/BindingService.js";

const mockFactory = DriveProviderFactory;
const mockSession = SessionManager;
const mockDriveRepo = DriveRepository;

describe("BindingService", () => {
    // Create local mocks for provider
    let mockProvider = {
        getBindingSteps: vi.fn(),
        handleInput: vi.fn(),
        getDisplayAccount: vi.fn(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset local mock
        mockProvider = {
            getBindingSteps: vi.fn(),
            handleInput: vi.fn(),
            getDisplayAccount: vi.fn((config) => config.user || config.bucket || 'configured'),
        };
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

    describe("default drive ownership", () => {
        it("应该通过 DriveRepository 设置默认盘", async () => {
            await BindingService.setDefaultDrive("user1", "drive1");

            expect(mockDriveRepo.setDefaultDrive).toHaveBeenCalledWith("user1", "drive1");
        });

        it("解绑只删除当前用户的 Drive，不再写 default_drive settings", async () => {
            mockDriveRepo.delete.mockResolvedValue(true);

            const result = await BindingService.unbindDrive("user1", "drive1");

            expect(mockDriveRepo.delete).toHaveBeenCalledWith("user1", "drive1");
            expect(result).toEqual({ success: true });
        });

        it("解绑目标不属于当前用户时返回失败", async () => {
            mockDriveRepo.delete.mockResolvedValue(false);

            const result = await BindingService.unbindDrive("user1", "drive1");

            expect(mockDriveRepo.delete).toHaveBeenCalledWith("user1", "drive1");
            expect(result).toEqual({ success: false });
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

        it("应该使用 Provider 展示账号生成 Drive 名称，避免 token 类配置出现 undefined", async () => {
            const session = { current_step: "OSS:STEP1", temp_data: "{}" };
            mockFactory.getSupportedTypes.mockReturnValue(["oss"]);
            mockFactory.isSupported.mockReturnValue(true);
            mockFactory.create.mockReturnValue(mockProvider);
            mockProvider.getBindingSteps.mockReturnValue([{ step: "STEP1" }]);
            mockProvider.handleInput.mockResolvedValue({ success: true, data: { bucket: "media-bucket" } });
            mockProvider.getDisplayAccount.mockReturnValue("media-bucket");

            await BindingService.handleInput("user1", session, "input");

            expect(mockDriveRepo.create).toHaveBeenCalledWith(
                "user1",
                "Oss-media-bucket",
                "oss",
                { bucket: "media-bucket" }
            );
        });

        it("应该在写库前调用 Provider 的存储规范化，保存带格式标记的凭证", async () => {
            const session = { current_step: "MEGA:WAIT_PASS", temp_data: "{}" };
            mockFactory.getSupportedTypes.mockReturnValue(["mega"]);
            mockFactory.isSupported.mockReturnValue(true);
            mockFactory.create.mockReturnValue(mockProvider);
            mockProvider.getBindingSteps.mockReturnValue([{ step: "WAIT_PASS" }]);
            mockProvider.handleInput.mockResolvedValue({ success: true, data: { user: "u@example.com", pass: "raw-pass" } });
            mockProvider.prepareConfigForStorage = vi.fn().mockResolvedValue({
                user: "u@example.com",
                pass: "obscured-pass",
                pass_format: "rclone_obscured",
                config_schema_version: 1
            });

            await BindingService.handleInput("user1", session, "raw-pass");

            expect(mockProvider.prepareConfigForStorage).toHaveBeenCalledWith({ user: "u@example.com", pass: "raw-pass" });
            expect(mockDriveRepo.create).toHaveBeenCalledWith(
                "user1",
                "Mega-u@example.com",
                "mega",
                {
                    user: "u@example.com",
                    pass: "obscured-pass",
                    pass_format: "rclone_obscured",
                    config_schema_version: 1
                }
            );
        });
    });
});
