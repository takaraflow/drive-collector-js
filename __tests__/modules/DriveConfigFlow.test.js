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
}));

// Mock services/rclone
const mockCloudTool = {
    validateConfig: vi.fn(),
};
vi.mock("../../src/services/rclone.js", () => ({
    CloudTool: mockCloudTool,
}));

// Mock repositories
const mockDriveRepository = {
    findByUserId: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    deleteByUserId: vi.fn(),
};
vi.mock("../../src/repositories/DriveRepository.js", () => ({
    DriveRepository: mockDriveRepository,
}));

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

// Mock utils/limiter
vi.mock("../../src/utils/limiter.js", () => ({
    runBotTask: vi.fn((fn) => fn()),
    runMtprotoTask: vi.fn((fn) => fn()),
    runBotTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoTaskWithRetry: vi.fn((fn) => fn()),
    PRIORITY: {
        HIGH: 10,
        UI: 20
    }
}));

// Mock locales
vi.mock("../../src/locales/zh-CN.js", () => ({
    STRINGS: {
        drive: {
            menu_title: "网盘管理",
            bound_list_title: "已绑定账号：",
            bound_info: "已绑定 {{type}} 账号: {{account}}",
            is_default: " (默认)",
            not_bound: "尚未绑定任何网盘",
            btn_set_default: "设为默认",
            btn_files: "查看文件",
            btn_unbind: "解绑账号",
            unbind_confirm: "确认解绑 {{type}} 账号 ({{account}})？",
            btn_confirm_unbind: "确认解绑",
            btn_cancel: "取消",
            success_unbind: "解绑成功",
            returned: "已返回",
            please_confirm: "请确认操作",
            mega_input_email: "请输入 Mega 邮箱：",
            mega_input_pass: "请输入密码：",
            check_input: "请检查输入",
            bind_failed: "绑定失败",
            mega_fail_2fa: "\n2FA 已启用，请先在网页端关闭",
            mega_fail_login: "\n账号或密码错误",
            mega_success: "绑定成功！\n邮箱: {{email}}",
            no_drive_unbind: "没有绑定网盘，无需解绑",
            set_default_success: "设为默认成功",
            no_drive_found: "没有找到已绑定的网盘",
            btn_bind: "绑定",
            btn_bind_other: "绑定其他网盘"
        }
    },
    format: (s, args) => {
        let res = s;
        if (args) {
            for (const key in args) {
                res = res.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), args[key]);
            }
        }
        return res;
    },
    escapeHTML: vi.fn(str => str)
}));

// Mock utils/common
vi.mock("../../src/utils/common.js", () => ({
    escapeHTML: vi.fn(str => str)
}));

// Mock DriveProviderFactory
const mockProvider = {
    getBindingSteps: vi.fn().mockReturnValue([
        { step: "WAIT_EMAIL", prompt: "mega_input_email" },
        { step: "WAIT_PASS", prompt: "mega_input_pass" }
    ]),
    handleInput: vi.fn().mockImplementation((step, text, session) => {
        if (step === "WAIT_EMAIL") {
            return Promise.resolve({ success: true, nextStep: "WAIT_PASS", data: { email: text }, message: "mega_input_pass" });
        }
        // For WAIT_PASS and others, assume final step success
        return Promise.resolve({ success: true, data: { user: "test@example.com", pass: text } });
    }),
};
vi.mock("../../src/services/drives/index.js", () => ({
    DriveProviderFactory: {
        create: vi.fn().mockReturnValue(mockProvider),
        getSupportedDrives: vi.fn().mockReturnValue([
            { type: "mega", name: "Mega" },
            { type: "googledrive", name: "Google Drive" }
        ]),
        isSupported: vi.fn().mockReturnValue(true)
    }
}));

// 导入 DriveConfigFlow
const { DriveConfigFlow } = await import("../../src/modules/DriveConfigFlow.js");

describe("DriveConfigFlow", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockClient.sendMessage.mockResolvedValue({ id: 300 });
        mockClient.editMessage.mockResolvedValue();
        mockClient.deleteMessages.mockResolvedValue();
        mockCloudTool.validateConfig.mockResolvedValue({ success: true });
        mockDriveRepository.findByUserId.mockResolvedValue([]);
        mockDriveRepository.findById.mockResolvedValue(null);
        mockDriveRepository.create.mockResolvedValue();
        mockDriveRepository.delete.mockResolvedValue();
        mockDriveRepository.deleteByUserId.mockResolvedValue();
        mockSettingsRepository.get.mockResolvedValue(null);
        mockSettingsRepository.set.mockResolvedValue();
        mockSessionManager.start.mockResolvedValue();
        mockSessionManager.update.mockResolvedValue();
        mockSessionManager.clear.mockResolvedValue();
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
                { id: "drive1", type: "mega", name: "Mega-user1@example.com" },
                { id: "drive2", type: "mega", name: "Mega-user2@example.com" }
            ];
            mockDriveRepository.findByUserId.mockResolvedValue(mockDrives);
            mockSettingsRepository.get.mockResolvedValue("drive1"); // drive1 is default

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
        test("should handle drive_set_default_", async () => {
            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_set_default_drive1") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockSettingsRepository.set).toHaveBeenCalledWith("default_drive_user456", "drive1");
            expect(mockClient.sendMessage).toHaveBeenCalled(); // sendDriveManager refresh
            expect(result).toBe("设为默认成功");
        });

        test("should handle drive_unbind_confirm_ with specific drive", async () => {
            const mockDrive = { id: "drive1", type: "mega", name: "Mega-test@example.com" };
            mockDriveRepository.findById.mockResolvedValue(mockDrive);

            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_unbind_confirm_drive1") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockClient.editMessage).toHaveBeenCalledWith("user123", expect.objectContaining({
                message: "msg100",
                text: expect.stringContaining("确认解绑 MEGA 账号"),
                parseMode: "html"
            }));
            expect(result).toBe("请确认操作");
        });

        test("should handle drive_unbind_execute_ with specific drive", async () => {
            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_unbind_execute_drive1") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockDriveRepository.delete).toHaveBeenCalledWith("drive1");
            expect(mockSettingsRepository.set).toHaveBeenCalledWith("default_drive_user456", null);
            expect(mockClient.sendMessage).toHaveBeenCalled(); // sendDriveManager refresh
            expect(result).toBe("解绑成功");
        });

        test("should handle drive_manager_back", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue([{ id: "drive1", type: "mega", name: "Mega-test@example.com" }]);

            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_manager_back") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockClient.sendMessage).toHaveBeenCalled(); // sendDriveManager refresh
            expect(result).toBe("已返回");
        });

        test("should handle drive_bind_mega", async () => {
            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_bind_mega") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockSessionManager.start).toHaveBeenCalledWith("user456", "MEGA_WAIT_EMAIL");
            expect(mockClient.sendMessage).toHaveBeenCalled();
            expect(result).toBe("请检查输入");
        });
    });

    describe("handleInput", () => {
        // (Unchanged from previous version, but ensure mocks are set correctly)
        test("should handle MEGA_WAIT_EMAIL with valid email", async () => {
            const event = {
                message: { message: "test@example.com", peerId: "chat123", id: "msg200" }
            };
            const session = { current_step: "MEGA_WAIT_EMAIL" };

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockSessionManager.update).toHaveBeenCalledWith("user456", "MEGA_WAIT_PASS", { email: "test@example.com" });
            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", {
                message: "mega_input_pass", // From mock return
                parseMode: "html"
            });
            expect(result).toBe(true);
        });

        test("should handle MEGA_WAIT_PASS with successful validation", async () => {
            const event = {
                message: { message: "password123", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA_WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            mockCloudTool.validateConfig.mockResolvedValue({ success: true });

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.deleteMessages).toHaveBeenCalledWith("chat123", ["msg200"], { revoke: true });
            expect(mockDriveRepository.create).toHaveBeenCalledWith("user456", "Mega-test@example.com", "mega", { user: "test@example.com", pass: "password123" });
            expect(mockSessionManager.clear).toHaveBeenCalledWith("user456");
            expect(mockClient.editMessage).toHaveBeenCalled();
            expect(result).toBe(true);
        });

        test("should handle CloudTool.validateConfig throwing error", async () => {
            const event = {
                message: { message: "password123", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA_WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            mockProvider.handleInput.mockResolvedValueOnce({ success: false, message: "Network error" });

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.editMessage).toHaveBeenCalledWith("chat123", {
                message: 300,
                text: "Network error",
                parseMode: "html"
            });
            expect(result).toBe(true);
        });

        test("should handle MEGA_WAIT_PASS with successful validation", async () => {
            const event = {
                message: { message: "password123", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA_WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.deleteMessages).toHaveBeenCalledWith("chat123", ["msg200"], { revoke: true });
            expect(mockDriveRepository.create).toHaveBeenCalledWith("user456", "Mega-test@example.com", "mega", { user: "test@example.com", pass: "password123" });
            expect(mockSessionManager.clear).toHaveBeenCalledWith("user456");
            expect(mockClient.editMessage).toHaveBeenCalled();
            expect(result).toBe(true);
        });
    });

    describe("handleUnbind", () => {
        test("should handle unbind when drives exist (delete all)", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue([{ id: "drive1" }]);

            await DriveConfigFlow.handleUnbind("chat123", "user456");

            expect(mockDriveRepository.deleteByUserId).toHaveBeenCalledWith("user456");
            expect(mockSettingsRepository.set).toHaveBeenCalledWith("default_drive_user456", null);
            expect(mockSessionManager.clear).toHaveBeenCalledWith("user456");
            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", expect.objectContaining({
                parseMode: "html"
            }));
        });

        test("should handle unbind when no drive exists", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue([]);

            await DriveConfigFlow.handleUnbind("chat123", "user456");

            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", {
                message: "没有绑定网盘，无需解绑",
                parseMode: "html"
            });
        });
    });

    describe("Edge Cases and Error Handling", () => {
        test("should handle CloudTool.validateConfig throwing error", async () => {
            const event = {
                message: { message: "password123", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA_WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            mockProvider.handleInput.mockResolvedValueOnce({ success: false, message: "Network error" });

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.editMessage).toHaveBeenCalledWith("chat123", {
                message: 300,
                text: "Network error",
                parseMode: "html"
            });
            expect(result).toBe(true);
        });
    });
});
