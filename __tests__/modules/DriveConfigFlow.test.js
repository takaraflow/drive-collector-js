import { describe, test, expect, beforeEach, vi } from 'vitest';

// 1. Mock 依赖项
// Mock config
vi.mock("../../src/config/index.js", () => ({
    config: {
        remoteFolder: "remote_folder"
    }
}));

const mockClient = {
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    deleteMessages: vi.fn(),
};
vi.mock("../../src/services/telegram.js", () => ({
    client: mockClient,
    ensureConnected: vi.fn().mockResolvedValue(undefined),
}));

// Mock services/rclone
const mockCloudTool = {
    validateConfig: vi.fn(),
};

// Mock logger to avoid CloudTool dependency issues
const mockLogger = {
    withModule: vi.fn(function() { return this; }),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
};

// Mock BaseDriveProvider to avoid circular dependency
const mockBaseDriveProvider = {
    processPassword: vi.fn().mockResolvedValue('password'),
};

vi.mock("../../src/services/drives/BaseDriveProvider.js", () => ({
    BaseDriveProvider: mockBaseDriveProvider,
}));

// Mock MegaProvider to use the mock BaseDriveProvider
const mockMegaProvider = {
    getBindingSteps: vi.fn(),
    handleInput: vi.fn(),
};

vi.mock("../../src/services/drives/MegaProvider.js", () => ({
    MegaProvider: mockMegaProvider,
}));

vi.mock("../../src/services/logger/index.js", () => ({
    logger: mockLogger,
}));

vi.mock("../../src/services/rclone.js", () => ({
    CloudTool: mockCloudTool,
}));

// Mock repositories
const mockDriveRepository = {
    findByUserId: vi.fn(),
    findById: vi.fn(),
    findByUserAndId: vi.fn(),
    getDefaultDrive: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    deleteByUserId: vi.fn(),
};
vi.mock("../../src/repositories/DriveRepository.js", () => ({
    DriveRepository: mockDriveRepository,
}));

// Mock BindingService
const mockBindingService = {
    unbindDrive: vi.fn(),
    setDefaultDrive: vi.fn(),
    startBinding: vi.fn(),
};

const mockSettingsRepository = {
    get: vi.fn(),
    set: vi.fn(),
};
vi.mock("../../src/repositories/SettingsRepository.js", () => ({
    SettingsRepository: mockSettingsRepository,
}));

// Mock modules/SessionManager
const mockSessionManager = {
    start: vi.fn(),
    update: vi.fn(),
    clear: vi.fn(),
};
vi.mock("../../src/modules/SessionManager.js", () => ({
    SessionManager: mockSessionManager,
}));

vi.mock("../../src/services/drives/BindingService.js", () => ({
    BindingService: mockBindingService,
}));

// Mock DriveProviderFactory with mock implementation
vi.mock("../../src/services/drives/index.js", () => ({
    DriveProviderFactory: {
        create: vi.fn().mockReturnValue({
            getBindingSteps: vi.fn().mockReturnValue([
                { step: "WAIT_EMAIL", prompt: "mega_input_email" },
                { step: "WAIT_PASS", prompt: "mega_input_pass" }
            ]),
            handleInput: vi.fn().mockImplementation((step, text, session) => {
                if (step === "WAIT_EMAIL") {
                    return Promise.resolve({ success: true, nextStep: "WAIT_PASS", data: { email: text }, message: "mega_input_pass" });
                }
                return Promise.resolve({ success: true, data: { user: "test@example.com", pass: text } });
            }),
            prepareConfigForStorage: vi.fn((config) => Promise.resolve({
                ...config,
                pass: `obscured_${config.pass}`,
                pass_format: "rclone_obscured",
                config_schema_version: 1
            })),
            getDisplayAccount: vi.fn((config) => config.user || config.bucket || "configured"),
        }),
        getSupportedDrives: vi.fn().mockReturnValue([
            { type: "mega", name: "Mega" },
            { type: "google_drive", name: "Google Drive", supportLevel: "advanced" },
            { type: "webdav", name: "WebDAV" },
            { type: "oss", name: "S3 / OSS", supportLevel: "advanced" },
            { type: "protondrive", name: "Proton Drive", supportLevel: "advanced" }
        ]),
        getSupportedTypes: vi.fn().mockReturnValue(["mega", "google_drive", "webdav", "oss", "protondrive"]),
        isSupported: vi.fn().mockReturnValue(true)
    }
}));

// 导入 DriveProviderFactory
import { DriveProviderFactory } from "../../src/services/drives/index.js";

// 导入 DriveConfigFlow
const { DriveConfigFlow } = await import("../../src/modules/DriveConfigFlow.js");

// Helper to get the mock provider
const getMockProvider = () => DriveProviderFactory.create();

describe("DriveConfigFlow", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockClient.sendMessage.mockResolvedValue({ id: 300 });
        mockClient.editMessage.mockResolvedValue();
        mockClient.deleteMessages.mockResolvedValue();
        mockCloudTool.validateConfig.mockResolvedValue({ success: true });
        mockDriveRepository.findByUserId.mockResolvedValue([]);
        mockDriveRepository.findById.mockResolvedValue(null);
        mockDriveRepository.findByUserAndId.mockResolvedValue(null);
        mockDriveRepository.getDefaultDrive.mockResolvedValue(null);
        mockDriveRepository.create.mockResolvedValue();
        mockDriveRepository.delete.mockResolvedValue();
        mockDriveRepository.deleteByUserId.mockResolvedValue();
        mockSettingsRepository.get.mockResolvedValue(null);
        mockSettingsRepository.set.mockResolvedValue();
        mockSessionManager.start.mockResolvedValue();
        mockSessionManager.update.mockResolvedValue();
        mockSessionManager.clear.mockResolvedValue();
        mockBindingService.unbindDrive.mockResolvedValue();
        mockBindingService.setDefaultDrive.mockResolvedValue();
        mockBindingService.startBinding.mockResolvedValue({ success: true, message: "请检查输入" });
        const mockProvider = getMockProvider();
        mockProvider.getBindingSteps.mockReturnValue([
            { step: "WAIT_EMAIL", prompt: "mega_input_email" },
            { step: "WAIT_PASS", prompt: "mega_input_pass" }
        ]);
        mockProvider.handleInput.mockImplementation((step, text, session) => {
            if (step === "WAIT_EMAIL") {
                return Promise.resolve({ success: true, nextStep: "WAIT_PASS", data: { email: text }, message: "mega_input_pass" });
            }
            return Promise.resolve({ success: true, data: { user: "test@example.com", pass: text } });
        });
        mockProvider.prepareConfigForStorage.mockImplementation((config) => Promise.resolve({
            ...config,
            pass: `obscured_${config.pass}`,
            pass_format: "rclone_obscured",
            config_schema_version: 1
        }));
    });

    describe("sendDriveManager", () => {
        test("should send manager panel with no drive bound", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue([]);

            await DriveConfigFlow.sendDriveManager("chat123", "user456");

            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", {
                message: expect.stringContaining("尚未绑定任何网盘"),
                buttons: expect.any(Array),
                parseMode: "html"
            });
            
            // Verify "Bind other" button is present
            const callArgs = mockClient.sendMessage.mock.calls[0][1];
            expect(callArgs.buttons.some(btn => btn[0].text.includes("绑定其他网盘"))).toBe(true);
        });

        test("should send manager panel with multiple drives bound", async () => {
            const mockDrives = [
                { id: "drive1", type: "mega", name: "Mega-user1@example.com", is_default: 1 },
                { id: "drive2", type: "mega", name: "Mega-user2@example.com" }
            ];
            mockDriveRepository.findByUserId.mockResolvedValue(mockDrives);

            await DriveConfigFlow.sendDriveManager("chat123", "user456");

            const callArgs = mockClient.sendMessage.mock.calls[0][1];
            
            // Check message content
            expect(callArgs.message).toContain("MEGA");
            expect(callArgs.message).toContain("user1@example.com");
            expect(callArgs.message).toContain("user2@example.com");
            expect(callArgs.message).toContain("⭐️"); // Default icon
            expect(callArgs.message).toContain("📁"); // Non-default icon

            // Verify buttons for each drive
            // drive1 (default) should NOT have "设为默认" button
            // drive2 (non-default) SHOULD have "设为默认" button
            
            // drive1 row: Unbind
            // drive2 row: 设为默认, Unbind
            // Final row: 查看文件
            // Final section: Bind other button -> 1 row
            
            expect(callArgs.buttons.length).toBe(4); // 2 drives + 1 view files + 1 bind other button
        });
        
        test("should show bind other button even when drives are bound", async () => {
             mockDriveRepository.findByUserId.mockResolvedValue([{ id: "drive1", type: "mega", name: "Mega-user1@example.com" }]);

            await DriveConfigFlow.sendDriveManager("chat123", "user456");

            const callArgs = mockClient.sendMessage.mock.calls[0][1];
            // The last button should be "绑定其他网盘"
            const lastButton = callArgs.buttons[callArgs.buttons.length - 1][0].text;
            expect(lastButton).toContain("绑定其他网盘");
        });
    });

    describe("handleCallback", () => {
        test("should pass full drive id when setting default drive", async () => {
            const driveId = "drive_1712345678901_abcd1234";
            const event = { userId: "user123", msgId: "msg100", data: Buffer.from(`drive_set_default_${driveId}`) };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockBindingService.setDefaultDrive).toHaveBeenCalledWith("user456", driveId);
            expect(mockClient.editMessage).toHaveBeenCalledWith("user123", expect.objectContaining({
                message: "msg100",
                text: expect.stringContaining("网盘管理中心"),
                buttons: expect.any(Array),
                parseMode: "html"
            }));
            expect(mockClient.sendMessage).not.toHaveBeenCalled();
            expect(result).toBe("✅ 默认网盘设置成功！");
        });

        test("should show unbind confirmation for full drive id", async () => {
            const driveId = "drive_1712345678901_abcd1234";
            const mockDrive = { id: driveId, type: "mega", name: "Mega-test@example.com" };
            mockDriveRepository.findByUserAndId.mockResolvedValue(mockDrive);

            const event = { userId: "user123", msgId: "msg100", data: Buffer.from(`drive_unbind_confirm_${driveId}`) };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockDriveRepository.findByUserAndId).toHaveBeenCalledWith("user456", driveId);
            expect(mockClient.editMessage).toHaveBeenCalledWith("user123", expect.objectContaining({
                message: "msg100",
                text: expect.stringContaining("确认解绑这个网盘"),
                parseMode: "html"
            }));
            const buttons = mockClient.editMessage.mock.calls[0][1].buttons;
            expect(buttons).toHaveLength(2);
            expect(buttons[0][0].text).toBe("保留网盘");
            expect(buttons[1][0].text).toBe("确认解绑");
            expect(result).toBe("请确认操作");
        });

        test("should not show unbind confirmation for a drive outside the current user", async () => {
            const driveId = "drive_1712345678901_abcd1234";
            mockDriveRepository.findByUserAndId.mockResolvedValue(null);

            const event = { userId: "user123", msgId: "msg100", data: Buffer.from(`drive_unbind_confirm_${driveId}`) };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockDriveRepository.findByUserAndId).toHaveBeenCalledWith("user456", driveId);
            expect(mockClient.editMessage).not.toHaveBeenCalled();
            expect(result).toBe("🚫 未找到对应网盘");
        });

        test("should unbind full drive id for the current user", async () => {
            const driveId = "drive_1712345678901_abcd1234";
            mockBindingService.unbindDrive.mockResolvedValue({ success: true });
            const event = { userId: "user123", msgId: "msg100", data: Buffer.from(`drive_unbind_execute_${driveId}`) };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockBindingService.unbindDrive).toHaveBeenCalledWith("user456", driveId);
            expect(mockClient.editMessage).toHaveBeenCalledWith("user123", expect.objectContaining({
                message: "msg100",
                text: expect.stringContaining("网盘管理中心"),
                buttons: expect.any(Array),
                parseMode: "html"
            }));
            expect(mockClient.sendMessage).not.toHaveBeenCalled();
            expect(result).toBe("已成功解绑");
        });

        test("should not report success when unbind target is not owned by current user", async () => {
            const driveId = "drive_1712345678901_abcd1234";
            mockBindingService.unbindDrive.mockResolvedValue({ success: false });
            const event = { userId: "user123", msgId: "msg100", data: Buffer.from(`drive_unbind_execute_${driveId}`) };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockBindingService.unbindDrive).toHaveBeenCalledWith("user456", driveId);
            expect(mockClient.editMessage).not.toHaveBeenCalled();
            expect(result).toBe("🚫 未找到对应网盘");
        });

        test("should execute all-drive unbind only after confirmation callback", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue([]);
            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_unbind_all_execute") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockDriveRepository.deleteByUserId).toHaveBeenCalledWith("user456");
            expect(mockSessionManager.clear).toHaveBeenCalledWith("user456");
            expect(mockClient.editMessage).toHaveBeenCalledWith("user123", expect.objectContaining({
                message: "msg100",
                text: expect.stringContaining("网盘管理中心"),
                buttons: expect.any(Array),
                parseMode: "html"
            }));
            expect(mockClient.sendMessage).not.toHaveBeenCalled();
            expect(result).toBe("已成功解绑");
        });

        test("should handle drive_manager_back", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue([{ id: "drive1", type: "mega", name: "Mega-test@example.com" }]);

            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_manager_back") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockClient.editMessage).toHaveBeenCalledWith("user123", expect.objectContaining({
                message: "msg100",
                text: expect.stringContaining("网盘管理中心"),
                buttons: expect.any(Array),
                parseMode: "html"
            }));
            expect(mockClient.sendMessage).not.toHaveBeenCalled();
            expect(result).toBe("已返回");
        });

        test("should handle drive_bind_mega", async () => {
            mockBindingService.startBinding.mockResolvedValue({
                success: true,
                driveType: "mega",
                step: "WAIT_EMAIL",
                prompt: "mega_input_email"
            });

            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_bind_mega") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockBindingService.startBinding).toHaveBeenCalledWith("user456", "mega");
            expect(mockClient.sendMessage).toHaveBeenCalled();
            expect(result).toBe("请查看输入提示");
        });

        test("should append credential notice from the flow layer for sensitive binding steps", async () => {
            mockBindingService.startBinding.mockResolvedValue({
                success: true,
                driveType: "google_drive",
                step: "WAIT_TOKEN",
                prompt: "input_token"
            });

            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_bind_google_drive") };

            await DriveConfigFlow.handleCallback(event, "user456");

            const sent = mockClient.sendMessage.mock.calls[0][1].message;
            expect(sent).toContain("请输入 Google Drive 的 JSON Token");
            expect(sent).toContain("为减少暴露，我会在提交后尝试删除这条敏感消息");
            expect(sent).toContain("发送 /cancel");
        });

        test("should show recommended drive choices first with a more-drives affordance", async () => {
            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_select_type") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            const payload = mockClient.editMessage.mock.calls[0][1];
            const labels = payload.buttons.flat().map(button => button.text);
            const callbackData = payload.buttons.flat().map(button => button.data.toString());
            expect(payload.text).toContain("推荐先选择常用网盘");
            expect(labels).toEqual(expect.arrayContaining(["🟢 Mega", "🌐 WebDAV"]));
            expect(labels).not.toContain("🔵 Google Drive · 需高级配置");
            expect(labels).not.toContain("🗄️ S3 / OSS");
            expect(callbackData).toContain("drive_select_type_all");
            expect(result).toBe("请确认操作");
        });

        test("should reveal advanced drive choices only after choosing more drives", async () => {
            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_select_type_all") };

            await DriveConfigFlow.handleCallback(event, "user456");

            const payload = mockClient.editMessage.mock.calls[0][1];
            const labels = payload.buttons.flat().map(button => button.text);
            const callbackData = payload.buttons.flat().map(button => button.data.toString());
            expect(payload.text).toContain("JSON Token");
            expect(payload.text).toContain("未覆盖所有账号类型");
            expect(labels).toContain("🔵 Google Drive · 需高级配置");
            expect(labels).toContain("🗄️ S3 / OSS · 需高级配置");
            expect(callbackData).toContain("drive_select_type");
        });
    });

    describe("handleInput", () => {
        // (Unchanged from previous version, but ensure mocks are set correctly)
        test("should handle MEGA_WAIT_EMAIL with valid email", async () => {
            const event = {
                message: { message: "test@example.com", peerId: "chat123", id: "msg200" }
            };
            const session = { current_step: "MEGA:WAIT_EMAIL" };

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockSessionManager.update).toHaveBeenCalledWith("user456", "MEGA:WAIT_PASS", { email: "test@example.com" });
            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", expect.objectContaining({
                parseMode: "html"
            }));
            expect(result).toBe(true);
        });

        test("should cancel binding when user sends cancel command", async () => {
            const event = {
                message: { message: "/cancel", peerId: "chat123", id: "msg201" }
            };
            const session = { current_step: "MEGA:WAIT_EMAIL" };

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockSessionManager.clear).toHaveBeenCalledWith("user456");
            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", expect.objectContaining({
                parseMode: "html"
            }));
            expect(result).toBe(true);
        });

        test("should handle MEGA_WAIT_PASS with successful validation", async () => {
            const event = {
                message: { message: "password123", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA:WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            mockCloudTool.validateConfig.mockResolvedValue({ success: true });

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.deleteMessages).toHaveBeenCalledWith("chat123", ["msg200"], { revoke: true });
            expect(mockDriveRepository.create).toHaveBeenCalledWith("user456", "Mega-test@example.com", "mega", {
                user: "test@example.com",
                pass: "obscured_password123",
                pass_format: "rclone_obscured",
                config_schema_version: 1
            });
            expect(mockSessionManager.clear).toHaveBeenCalledWith("user456");
            expect(mockClient.editMessage).toHaveBeenCalled();
            const editPayload = mockClient.editMessage.mock.calls[0][1];
            expect(editPayload.buttons.flat().map(button => button.data.toString())).toEqual(
                expect.arrayContaining(["files_page_0", "remote_folder_menu"])
            );
            expect(result).toBe(true);
        });

        test("should delete sensitive non-final binding input without sending verifying message", async () => {
            const event = {
                message: { message: '{"access_token":"token"}', peerId: "chat123", id: "msg201" }
            };
            const session = { current_step: "GOOGLE_DRIVE:WAIT_TOKEN" };
            const mockProvider = DriveProviderFactory.create();
            mockProvider.getBindingSteps.mockReturnValue([
                { step: "WAIT_TOKEN", prompt: "input_token" },
                { step: "WAIT_EXTRA", prompt: "input_extra" }
            ]);
            mockProvider.handleInput.mockResolvedValueOnce({
                success: true,
                nextStep: "WAIT_EXTRA",
                data: { token: '{"access_token":"token"}' },
                message: "input_extra"
            });

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.deleteMessages).toHaveBeenCalledWith("chat123", ["msg201"], { revoke: true });
            expect(mockSessionManager.update).toHaveBeenCalledWith(
                "user456",
                "GOOGLE_DRIVE:WAIT_EXTRA",
                { token: '{"access_token":"token"}' }
            );
            expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
            expect(mockClient.sendMessage.mock.calls[0][1].message).not.toContain("正在验证");
            expect(result).toBe(true);
        });

        test("should handle provider handleInput returning failure", async () => {
            const event = {
                message: { message: "password123", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA:WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            const mockProvider = DriveProviderFactory.create();
            mockProvider.handleInput.mockResolvedValueOnce({ success: false, message: "Network error" });

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.editMessage).toHaveBeenCalledWith("chat123", expect.objectContaining({
                text: expect.stringContaining("绑定失败"),
                buttons: expect.any(Array),
                parseMode: "html"
            }));
            const failurePayload = mockClient.editMessage.mock.calls[0][1];
            expect(failurePayload.text).toContain("Network error");
            expect(failurePayload.text).toContain("重新绑定");
            expect(failurePayload.buttons.flat().map(button => button.data.toString())).toEqual(
                expect.arrayContaining(["drive_select_type", "drive_manager_back"])
            );
            expect(result).toBe(true);
        });

        test("should handle MEGA_WAIT_PASS with successful validation (second)", async () => {
            const event = {
                message: { message: "password123", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA:WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.deleteMessages).toHaveBeenCalledWith("chat123", ["msg200"], { revoke: true });
            expect(mockDriveRepository.create).toHaveBeenCalledWith("user456", "Mega-test@example.com", "mega", {
                user: "test@example.com",
                pass: "obscured_password123",
                pass_format: "rclone_obscured",
                config_schema_version: 1
            });
            expect(mockSessionManager.clear).toHaveBeenCalledWith("user456");
            expect(mockClient.editMessage).toHaveBeenCalled();
            expect(result).toBe(true);
        });
    });

    describe("handleUnbind", () => {
        test("should ask for confirmation before unbinding all drives", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue([{ id: "drive1" }]);

            await DriveConfigFlow.handleUnbind("chat123", "user456");

            expect(mockDriveRepository.deleteByUserId).not.toHaveBeenCalled();
            expect(mockSettingsRepository.set).not.toHaveBeenCalledWith("default_drive_user456", null);
            expect(mockSessionManager.clear).not.toHaveBeenCalledWith("user456");
            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", expect.objectContaining({
                message: expect.stringContaining("确认解绑所有网盘"),
                buttons: expect.any(Array),
                parseMode: "html"
            }));
        });

        test("should handle unbind when no drive exists", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue([]);

            await DriveConfigFlow.handleUnbind("chat123", "user456");

            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", {
                message: "⚠️ 您当前未绑定任何网盘，无需解绑。请输入 /drive 绑定一个新的网盘。",
                parseMode: "html"
            });
        });
    });

    describe("Edge Cases and Error Handling", () => {
        test("should handle provider handleInput failure in edge case", async () => {
            const event = {
                message: { message: "password123", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA:WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            const mockProvider = DriveProviderFactory.create();
            mockProvider.handleInput.mockResolvedValueOnce({ success: false, message: "Network error" });

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.editMessage).toHaveBeenCalledWith("chat123", expect.objectContaining({
                text: expect.stringContaining("绑定失败"),
                buttons: expect.any(Array),
                parseMode: "html"
            }));
            const failurePayload = mockClient.editMessage.mock.calls[0][1];
            expect(failurePayload.text).toContain("Network error");
            expect(failurePayload.text).toContain("换用其他网盘");
            expect(result).toBe(true);
        });
    });
});
