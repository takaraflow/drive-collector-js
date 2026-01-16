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
    create: vi.fn(),
    delete: vi.fn(),
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
            bound_info: "已绑定 {{type}} 账号: {{account}}",
            is_default: " (默认)",
            not_bound: "尚未绑定任何网盘",
            btn_set_default: "设为默认",
            btn_files: "查看文件",
            btn_unbind: "解绑账号",
            unbind_confirm: "确认解绑？",
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
            set_default_success: "设为默认成功"
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

// 导入 DriveConfigFlow
const { DriveConfigFlow } = await import("../../src/modules/DriveConfigFlow.js");

describe("DriveConfigFlow", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset all mocks to default behavior
        mockClient.sendMessage.mockResolvedValue({ id: 300 });
        mockClient.editMessage.mockResolvedValue();
        mockClient.deleteMessages.mockResolvedValue();
        mockCloudTool.validateConfig.mockResolvedValue({ success: true });
        mockDriveRepository.findByUserId.mockResolvedValue(null);
        mockDriveRepository.create.mockResolvedValue();
        mockDriveRepository.delete.mockResolvedValue();
        mockSettingsRepository.get.mockResolvedValue(null);
        mockSettingsRepository.set.mockResolvedValue();
        mockSessionManager.start.mockResolvedValue();
        mockSessionManager.update.mockResolvedValue();
        mockSessionManager.clear.mockResolvedValue();
    });

    describe("sendDriveManager", () => {
        test("should send manager panel with no drive bound", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue(null);

            await DriveConfigFlow.sendDriveManager("chat123", "user456");

            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", {
                message: expect.stringContaining("尚未绑定任何网盘"),
                buttons: expect.any(Array),
                parseMode: "html"
            });
        });

        test("should send manager panel with drive bound", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue({
                id: "drive1",
                type: "mega",
                name: "Mega-test@example.com"
            });
            mockSettingsRepository.get.mockResolvedValue("drive1"); // is default

            await DriveConfigFlow.sendDriveManager("chat123", "user456");

            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", {
                message: expect.stringContaining("已绑定 MEGA 账号"),
                buttons: expect.any(Array),
                parseMode: "html"
            });
        });
    });

    describe("handleCallback", () => {
        test("should handle drive_set_default_", async () => {
            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_set_default_drive1") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockSettingsRepository.set).toHaveBeenCalledWith("default_drive_user456", "drive1");
            expect(result).toBe("设为默认成功");
        });

        test("should handle drive_unbind_confirm", async () => {
            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_unbind_confirm") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockClient.editMessage).toHaveBeenCalledWith("user123", expect.objectContaining({
                message: "msg100",
                text: expect.stringContaining("确认解绑？"),
                parseMode: "html"
            }));
            expect(result).toBe("请确认操作");
        });

        test("should handle drive_unbind_execute", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue({ id: "drive1" });

            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_unbind_execute") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockDriveRepository.delete).toHaveBeenCalledWith("drive1");
            expect(mockSettingsRepository.set).toHaveBeenCalledWith("default_drive_user456", null);
            expect(mockSessionManager.clear).toHaveBeenCalledWith("user456");
            expect(result).toBe("解绑成功");
        });

        test("should handle drive_manager_back", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue({
                id: "drive1",
                type: "mega",
                name: "Mega-test@example.com"
            });

            const event = { userId: "user123", msgId: "msg100", data: Buffer.from("drive_manager_back") };

            const result = await DriveConfigFlow.handleCallback(event, "user456");

            expect(mockClient.editMessage).toHaveBeenCalled();
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
        test("should handle MEGA_WAIT_EMAIL with valid email", async () => {
            const event = {
                message: { message: "test@example.com", peerId: "chat123", id: "msg200" }
            };
            const session = { current_step: "MEGA_WAIT_EMAIL" };

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockSessionManager.update).toHaveBeenCalledWith("user456", "MEGA_WAIT_PASS", { email: "test@example.com" });
            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", {
                message: expect.stringContaining("请输入密码"),
                parseMode: "html"
            });
            expect(result).toBe(true);
        });

        test("should handle MEGA_WAIT_EMAIL with invalid email", async () => {
            const event = {
                message: { message: "invalid-email", peerId: "chat123", id: "msg200" }
            };
            const session = { current_step: "MEGA_WAIT_EMAIL" };

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", {
                message: "❌ 邮箱格式看似不正确，请重新输入："
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
            expect(mockCloudTool.validateConfig).toHaveBeenCalledWith("mega", { user: "test@example.com", pass: "password123" });
            expect(mockDriveRepository.create).toHaveBeenCalledWith("user456", "Mega-test@example.com", "mega", { user: "test@example.com", pass: "password123" });
            expect(mockSessionManager.clear).toHaveBeenCalledWith("user456");
            expect(mockClient.editMessage).toHaveBeenCalled();
            expect(result).toBe(true);
        });

        test("should handle MEGA_WAIT_PASS with 2FA error", async () => {
            const event = {
                message: { message: "password123", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA_WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            mockCloudTool.validateConfig.mockResolvedValue({
                success: false,
                reason: "2FA",
                details: "Multi-factor authentication required"
            });

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.editMessage).toHaveBeenCalledWith("chat123", {
                message: 300,
                text: expect.stringContaining("2FA 已启用"),
                parseMode: "html"
            });
            expect(mockSessionManager.clear).toHaveBeenCalledWith("user456");
            expect(result).toBe(true);
        });

        test("should handle MEGA_WAIT_PASS with login error", async () => {
            const event = {
                message: { message: "wrongpass", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA_WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            mockCloudTool.validateConfig.mockResolvedValue({
                success: false,
                reason: "ERROR",
                details: "couldn't login"
            });

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.editMessage).toHaveBeenCalledWith("chat123", {
                message: 300,
                text: expect.stringContaining("账号或密码错误"),
                parseMode: "html"
            });
            expect(result).toBe(true);
        });

        test("should handle MEGA_WAIT_PASS with generic error", async () => {
            const event = {
                message: { message: "password123", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA_WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            mockCloudTool.validateConfig.mockResolvedValue({
                success: false,
                reason: "ERROR",
                details: "Network timeout"
            });

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.editMessage).toHaveBeenCalledWith("chat123", {
                message: 300,
                text: expect.stringContaining("网络或配置异常"),
                parseMode: "html"
            });
            expect(result).toBe(true);
        });

        test("should return false for non-matching session step", async () => {
            const event = {
                message: { message: "some input", peerId: "chat123", id: "msg200" }
            };
            const session = { current_step: "UNKNOWN_STEP" };

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(result).toBe(false);
        });
    });

    describe("handleUnbind", () => {
        test("should handle unbind when drive exists", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue({ id: "drive1" });

            await DriveConfigFlow.handleUnbind("chat123", "user456");

            expect(mockDriveRepository.delete).toHaveBeenCalledWith("drive1");
            expect(mockSettingsRepository.set).toHaveBeenCalledWith("default_drive_user456", null);
            expect(mockSessionManager.clear).toHaveBeenCalledWith("user456");
            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", expect.objectContaining({
                parseMode: "html"
            }));
        });

        test("should handle unbind when no drive exists", async () => {
            mockDriveRepository.findByUserId.mockResolvedValue(null);

            await DriveConfigFlow.handleUnbind("chat123", "user456");

            expect(mockClient.sendMessage).toHaveBeenCalledWith("chat123", {
                message: "没有绑定网盘，无需解绑",
                parseMode: "html"
            });
        });
    });

    describe("Edge Cases and Error Handling", () => {
        test("should throw error for malformed session temp_data in MEGA_WAIT_PASS", async () => {
            const event = {
                message: { message: "password123", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA_WAIT_PASS",
                temp_data: "invalid-json"
            };

            // Should throw SyntaxError due to invalid JSON
            await expect(DriveConfigFlow.handleInput(event, "user456", session)).rejects.toThrow(SyntaxError);
        });

        test("should handle CloudTool.validateConfig throwing error", async () => {
            const event = {
                message: { message: "password123", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA_WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            mockCloudTool.validateConfig.mockRejectedValue(new Error("Network error"));

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockClient.editMessage).toHaveBeenCalledWith("chat123", {
                message: 300,
                text: expect.stringContaining("绑定失败"),
                parseMode: "html"
            });
            expect(result).toBe(true);
        });

        test("should handle password with special characters", async () => {
            const event = {
                message: { message: "pass$word!@#", peerId: "chat123", id: "msg200" }
            };
            const session = {
                current_step: "MEGA_WAIT_PASS",
                temp_data: JSON.stringify({ email: "test@example.com" })
            };

            mockCloudTool.validateConfig.mockResolvedValue({ success: true });

            const result = await DriveConfigFlow.handleInput(event, "user456", session);

            expect(mockCloudTool.validateConfig).toHaveBeenCalledWith("mega", {
                user: "test@example.com",
                pass: "pass$word!@#"
            });
            expect(result).toBe(true);
        });
    });
});