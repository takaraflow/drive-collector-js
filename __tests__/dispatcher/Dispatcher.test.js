import { jest, describe, test, expect, beforeEach } from "@jest/globals";
import { Api } from "telegram";

// 1. Mock dependencies
jest.unstable_mockModule("../../src/config/index.js", () => ({
  config: {
    ownerId: "123456",
  },
}));

const mockClient = {
  invoke: jest.fn().mockImplementation(() => {
    const p = Promise.resolve();
    p.catch = (fn) => p;
    return p;
  }),
  sendMessage: jest.fn().mockImplementation(() => Promise.resolve({ id: 1 })),
};
jest.unstable_mockModule("../../src/services/telegram.js", () => ({
  client: mockClient,
}));

const mockAuthGuard = {
  getRole: jest.fn(),
  can: jest.fn(),
};
jest.unstable_mockModule("../../src/modules/AuthGuard.js", () => ({
  AuthGuard: mockAuthGuard,
}));

const mockSessionManager = {
  get: jest.fn(),
};
jest.unstable_mockModule("../../src/modules/SessionManager.js", () => ({
  SessionManager: mockSessionManager,
}));

const mockDriveConfigFlow = {
  handleCallback: jest.fn(),
  handleInput: jest.fn(),
  sendDriveManager: jest.fn(),
  handleUnbind: jest.fn(),
};
jest.unstable_mockModule("../../src/modules/DriveConfigFlow.js", () => ({
  DriveConfigFlow: mockDriveConfigFlow,
}));

const mockTaskManager = {
  cancelTask: jest.fn(),
  addTask: jest.fn(),
  addBatchTasks: jest.fn(),
  waitingTasks: [],
  currentTask: null,
  getWaitingCount: jest.fn(() => 0),
  getProcessingCount: jest.fn(() => 0),
};
jest.unstable_mockModule("../../src/processor/TaskManager.js", () => ({
  TaskManager: mockTaskManager,
}));

const mockQstashService = {
  scheduleMediaGroupBatch: jest.fn(),
};
jest.unstable_mockModule("../../src/services/QStashService.js", () => ({
  qstashService: mockQstashService,
}));

const mockLinkParser = {
  parse: jest.fn(),
};
jest.unstable_mockModule("../../src/processor/LinkParser.js", () => ({
  LinkParser: mockLinkParser,
}));

const mockUIHelper = {
  renderFilesPage: jest.fn(() => ({ text: "mock_text", buttons: [] })),
};
jest.unstable_mockModule("../../src/ui/templates.js", () => ({
  UIHelper: mockUIHelper,
}));

const mockCloudTool = {
  listRemoteFiles: jest.fn(),
  isLoading: jest.fn(() => false),
};
jest.unstable_mockModule("../../src/services/rclone.js", () => ({
  CloudTool: mockCloudTool,
}));

const mockSettingsRepository = {
  get: jest.fn(),
  set: jest.fn(),
};
jest.unstable_mockModule("../../src/repositories/SettingsRepository.js", () => ({
  SettingsRepository: mockSettingsRepository,
}));

const mockDriveRepository = {
  findById: jest.fn(),
  findByUserId: jest.fn(),
};
jest.unstable_mockModule("../../src/repositories/DriveRepository.js", () => ({
  DriveRepository: mockDriveRepository,
}));

const mockTaskRepository = {
  findByUserId: jest.fn(),
};
jest.unstable_mockModule("../../src/repositories/TaskRepository.js", () => ({
  TaskRepository: mockTaskRepository,
}));

// Mock utils
jest.unstable_mockModule("../../src/utils/common.js", () => ({
  safeEdit: jest.fn(),
  escapeHTML: jest.fn((str) => str),
}));

jest.unstable_mockModule("../../src/utils/limiter.js", () => ({
  runBotTask: jest.fn((fn) => fn()),
  runBotTaskWithRetry: jest.fn((fn) => fn()),
  PRIORITY: {
    UI: 20,
    HIGH: 10,
    NORMAL: 0,
    LOW: -10,
    BACKGROUND: -20
  }
}));

// Mock locales
jest.unstable_mockModule("../../src/locales/zh-CN.js", () => ({
  STRINGS: {
    task: { cmd_sent: "sent", task_not_found: "not found" },
    system: { welcome: "welcome", maintenance_mode: "🚧 <b>系统维护中</b>\n\n当前 Bot 仅限管理员使用，请稍后访问。" },
    drive: { no_drive_found: "no drive" },
    status: { header: "header", queue_title: "queue", waiting_tasks: "🕒 等待中的任务: {{count}}", current_task: "🔄 当前正在处理: {{count}}", current_file: "📄 当前任务: <code>{{name}}</code>", user_history: "👤 您的任务历史", task_item: "{{index}}. {{status}} <code>{{name}}</code> ({{statusText}})", drive_status: "🔑 网盘绑定: {{status}}", system_info: "💻 系统信息", uptime: "⏱️ 运行时间: {{uptime}}", service_status: "📡 服务状态: {{status}}", mode_changed: "✅ <b>访问模式已切换</b>\n\n当前模式: <code>{{mode}}</code>", no_permission: "❌ <b>无权限</b>\n\n此操作仅限管理员执行。" }
  },
  format: (template, vars = {}) => template.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] !== undefined && vars[key] !== null) ? vars[key] : `{{${key}}}`),
}));

// Load Dispatcher
const { Dispatcher } = await import("../../src/dispatcher/Dispatcher.js");

describe("Dispatcher", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Dispatcher.groupBuffers.clear();
    Dispatcher.lastRefreshTime = 0;
  });

  describe("_extractContext", () => {
    test("should extract context from UpdateBotCallbackQuery", () => {
      const event = new Api.UpdateBotCallbackQuery({
        userId: BigInt(123),
        peer: new Api.PeerUser({ userId: BigInt(123) }),
      });
      const ctx = Dispatcher._extractContext(event);
      expect(ctx.userId).toBe("123");
      expect(ctx.isCallback).toBe(true);
    });

    test("should extract context from UpdateNewMessage", () => {
      const mockMessage = {
        id: 1,
        fromId: { userId: BigInt(456) },
        peerId: { userId: BigInt(456) },
        className: "Message"
      };
      const event = new Api.UpdateNewMessage({
        message: mockMessage
      });
      const ctx = Dispatcher._extractContext(event);
      expect(ctx.userId).toBe("456");
      expect(ctx.isCallback).toBe(false);
    });
  });

  describe("_globalGuard", () => {
    test("should allow owner", async () => {
      mockAuthGuard.getRole.mockResolvedValue("owner");
      const passed = await Dispatcher._globalGuard({}, { userId: "123456" });
      expect(passed).toBe(true);
    });

    test("should block non-owner in maintenance mode", async () => {
      mockAuthGuard.getRole.mockResolvedValue("user");
      mockAuthGuard.can.mockResolvedValue(false);
      mockSettingsRepository.get.mockResolvedValue("private");
      const event = { queryId: "qid" };
      const passed = await Dispatcher._globalGuard(event, { userId: "789", isCallback: true });

      expect(passed).toBe(false);
      expect(mockClient.invoke).toHaveBeenCalled();
    });
  });

  describe("_handleCallback", () => {
    test("should handle cancel task callback", async () => {
      const event = new Api.UpdateBotCallbackQuery({
        data: Buffer.from("cancel_task123"),
        userId: BigInt(123),
        queryId: BigInt(1),
        peer: new Api.PeerUser({ userId: BigInt(123) }),
      });
      mockTaskManager.cancelTask.mockResolvedValue(true);

      await Dispatcher._handleCallback(event, { userId: "123" });
      expect(mockTaskManager.cancelTask).toHaveBeenCalledWith("task123", "123");
      expect(mockClient.invoke).toHaveBeenCalled();
    });

    test("should handle noop callback", async () => {
      const event = new Api.UpdateBotCallbackQuery({
        data: Buffer.from("noop"),
        userId: BigInt(123),
        queryId: BigInt(1),
        peer: new Api.PeerUser({ userId: BigInt(123) }),
      });

      await Dispatcher._handleCallback(event, { userId: "123" });
      expect(mockClient.invoke).toHaveBeenCalledWith(
        new Api.messages.SetBotCallbackAnswer({
          queryId: BigInt(1),
          message: ""
        })
      );
    });

    test("should handle drive callbacks", async () => {
      const event = new Api.UpdateBotCallbackQuery({
        data: Buffer.from("drive_bind_mega"),
        userId: BigInt(123),
        queryId: BigInt(1),
        peer: new Api.PeerUser({ userId: BigInt(123) }),
      });
      mockDriveConfigFlow.handleCallback.mockResolvedValue("test toast");

      await Dispatcher._handleCallback(event, { userId: "123" });
      expect(mockDriveConfigFlow.handleCallback).toHaveBeenCalledWith(event, "123");
    });

    test("should handle files callbacks", async () => {
      const event = new Api.UpdateBotCallbackQuery({
        data: Buffer.from("files_page_0"),
        userId: BigInt(123),
        queryId: BigInt(1),
        peer: new Api.PeerUser({ userId: BigInt(123) }),
        msgId: 456,
      });

      await Dispatcher._handleCallback(event, { userId: "123" });
      expect(mockCloudTool.listRemoteFiles).toHaveBeenCalledWith("123", false);
      expect(mockUIHelper.renderFilesPage).toHaveBeenCalled();
    });


  });

  describe("_handleMessage", () => {
    const target = { className: "PeerUser", userId: BigInt(123) };

    test("should handle /start command with fast path", async () => {
      mockSettingsRepository.get.mockResolvedValue("public");

      const message = {
        id: 1,
        message: "/start",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockSettingsRepository.get).toHaveBeenCalledWith("access_mode", "public");
      expect(mockAuthGuard.getRole).not.toHaveBeenCalled(); // 确保不查询用户角色
      expect(mockClient.sendMessage).toHaveBeenCalledWith(target, {
        message: "welcome",
        parseMode: "html"
      });
    });

    test("should handle /start in maintenance mode for non-owner", async () => {
      mockSettingsRepository.get.mockResolvedValue("private");

      const message = {
        id: 1,
        message: "/start",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "789", target });

      expect(mockClient.sendMessage).toHaveBeenCalledWith(target, {
        message: expect.stringContaining("维护中"),
        parseMode: "html"
      });
    });

    test("should handle /start in maintenance mode for owner", async () => {
      mockSettingsRepository.get.mockResolvedValue("private");

      const message = {
        id: 1,
        message: "/start",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123456", target });

      expect(mockClient.sendMessage).toHaveBeenCalledWith(target, {
        message: "welcome",
        parseMode: "html"
      });
    });

    test("should handle media messages", async () => {
      mockSessionManager.get.mockResolvedValue(null);
      mockDriveRepository.findByUserId.mockResolvedValue({ id: 1 });

      const message = {
        id: 1,
        media: { className: "MessageMediaPhoto" },
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });
      expect(mockTaskManager.addTask).toHaveBeenCalledWith(target, event.message, "123", "文件");
    });

    test("should aggregate grouped media", async () => {
      jest.useFakeTimers();
      mockSessionManager.get.mockResolvedValue(null);
      mockDriveRepository.findByUserId.mockResolvedValue({ id: 1 });
      mockTaskManager.addBatchTasks.mockResolvedValue(['task1', 'task2']);

      const common = {
        media: { className: "MessageMediaPhoto" },
        peerId: target,
        groupedId: BigInt(999)
      };
      const event1 = { message: { ...common, id: 1 } };
      const event2 = { message: { ...common, id: 2 } };

      await Dispatcher._handleMessage(event1, { userId: "123", target });
      await Dispatcher._handleMessage(event2, { userId: "123", target });

      expect(Dispatcher.groupBuffers.has("999")).toBe(true);
      expect(Dispatcher.groupBuffers.get("999").messages).toHaveLength(2);

      jest.runAllTimers();
      await Promise.resolve();

      expect(mockTaskManager.addBatchTasks).toHaveBeenCalledWith(target, [event1.message, event2.message], "123");
      expect(mockQstashService.scheduleMediaGroupBatch).toHaveBeenCalledWith("999", ['task1', 'task2'], 1);
      jest.useRealTimers();
    });

    test("should handle media group aggregation timeout", async () => {
      jest.useFakeTimers();
      mockSessionManager.get.mockResolvedValue(null);
      mockDriveRepository.findByUserId.mockResolvedValue({ id: 1 });
      mockTaskManager.addBatchTasks.mockResolvedValue(['task1']);

      const message = {
        media: { className: "MessageMediaPhoto" },
        peerId: target,
        groupedId: BigInt(888),
        id: 1
      };
      const event = { message };

      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(Dispatcher.groupBuffers.has("888")).toBe(true);

      // Advance timer by exactly 800ms
      jest.advanceTimersByTime(800);
      await Promise.resolve();

      expect(mockTaskManager.addBatchTasks).toHaveBeenCalledWith(target, [message], "123");
      expect(mockQstashService.scheduleMediaGroupBatch).toHaveBeenCalledWith("888", ['task1'], 1);

      // Buffer should be cleared
      expect(Dispatcher.groupBuffers.has("888")).toBe(false);

      jest.useRealTimers();
    });

    test("should handle /drive command", async () => {
      const message = {
        id: 1,
        message: "/drive",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockDriveConfigFlow.sendDriveManager).toHaveBeenCalledWith(target, "123");
    });

    test("should handle /logout command", async () => {
      const message = {
        id: 1,
        message: "/logout",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockDriveConfigFlow.handleUnbind).toHaveBeenCalledWith(target, "123");
    });

    test("should handle /status command", async () => {
      const message = {
        id: 1,
        message: "/status",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockClient.sendMessage).toHaveBeenCalled();
    });

    test("should handle /status queue subcommand", async () => {
      const message = {
        id: 1,
        message: "/status queue",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockClient.sendMessage).toHaveBeenCalled();
    });

    test("should handle /status_public command for admin", async () => {
      mockAuthGuard.can.mockResolvedValue(true);
      mockSettingsRepository.set.mockResolvedValue();

      const message = {
        id: 1,
        message: "/status_public",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockAuthGuard.can).toHaveBeenCalledWith("123", "maintenance:bypass");
      expect(mockSettingsRepository.set).toHaveBeenCalledWith("access_mode", "public");
      expect(mockClient.sendMessage).toHaveBeenCalledWith(target, {
        message: "✅ <b>访问模式已切换</b>\n\n当前模式: <code>公开</code>",
        parseMode: "html"
      });
    });

    test("should handle /status_private command for admin", async () => {
      mockAuthGuard.can.mockResolvedValue(true);
      mockSettingsRepository.set.mockResolvedValue();

      const message = {
        id: 1,
        message: "/status_private",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockAuthGuard.can).toHaveBeenCalledWith("123", "maintenance:bypass");
      expect(mockSettingsRepository.set).toHaveBeenCalledWith("access_mode", "private");
      expect(mockClient.sendMessage).toHaveBeenCalledWith(target, {
        message: "✅ <b>访问模式已切换</b>\n\n当前模式: <code>私有(维护)</code>",
        parseMode: "html"
      });
    });

    test("should reject /status_public command for non-admin", async () => {
      mockAuthGuard.can.mockResolvedValue(false);

      const message = {
        id: 1,
        message: "/status_public",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockAuthGuard.can).toHaveBeenCalledWith("123", "maintenance:bypass");
      expect(mockSettingsRepository.set).not.toHaveBeenCalled();
      expect(mockClient.sendMessage).toHaveBeenCalledWith(target, {
        message: "❌ <b>无权限</b>\n\n此操作仅限管理员执行。",
        parseMode: "html"
      });
    });

    test("should parse and process links", async () => {
      mockSessionManager.get.mockResolvedValue(null);
      mockDriveRepository.findByUserId.mockResolvedValue({ id: 1 });
      mockLinkParser.parse.mockResolvedValue([{ url: "https://example.com/file.mp4" }]);

      const message = {
        id: 1,
        message: "https://example.com/file.mp4",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockLinkParser.parse).toHaveBeenCalledWith("https://example.com/file.mp4", "123");
      expect(mockTaskManager.addTask).toHaveBeenCalled();
    });

    test("should limit link processing to 10 items", async () => {
      mockSessionManager.get.mockResolvedValue(null);
      mockDriveRepository.findByUserId.mockResolvedValue({ id: 1 });
      const links = Array.from({ length: 15 }, (_, i) => ({ url: `https://example.com/file${i}.mp4` }));
      mockLinkParser.parse.mockResolvedValue(links);

      const message = {
        id: 1,
        message: "multiple links...",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockTaskManager.addTask).toHaveBeenCalledTimes(10);
    });

    test("should send bind hint when processing links without drive", async () => {
      mockSessionManager.get.mockResolvedValue(null);
      mockDriveRepository.findByUserId.mockResolvedValue(null);
      mockLinkParser.parse.mockResolvedValue([{ url: "https://example.com/file.mp4" }]);

      const message = {
        id: 1,
        message: "https://example.com/file.mp4",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockClient.sendMessage).toHaveBeenCalledWith(target, expect.objectContaining({
        message: "no drive"
      }));
    });

    test("should handle invalid links", async () => {
      mockSessionManager.get.mockResolvedValue(null);
      mockLinkParser.parse.mockRejectedValue(new Error("Invalid URL"));

      const message = {
        id: 1,
        message: "invalid-link",
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockClient.sendMessage).toHaveBeenCalledWith(target, expect.objectContaining({
        message: expect.stringContaining("❌")
      }));
    });

    test("should block media messages when no drive bound", async () => {
      mockSessionManager.get.mockResolvedValue(null);
      mockDriveRepository.findByUserId.mockResolvedValue(null);

      const message = {
        id: 1,
        media: { className: "MessageMediaPhoto" },
        peerId: target
      };
      const event = { message };
      await Dispatcher._handleMessage(event, { userId: "123", target });

      expect(mockClient.sendMessage).toHaveBeenCalledWith(target, expect.objectContaining({
        message: "no drive"
      }));
      expect(mockTaskManager.addTask).not.toHaveBeenCalled();
    });
  });

  describe("handle", () => {
    const ownerId = "123456";

    test("should log blocked messages in globalGuard", async () => {
      mockAuthGuard.getRole.mockResolvedValue("user");
      mockAuthGuard.can.mockResolvedValue(false);
      mockSettingsRepository.get.mockResolvedValue("private");
      
      const logSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
      
      const event = {
        userId: BigInt(789),
        peer: { className: "PeerUser", userId: BigInt(789) },
        className: "UpdateBotCallbackQuery"
      };

      await Dispatcher.handle(event);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("🛡️ 消息被全局守卫拦截"), expect.anything());
      logSpy.mockRestore();
    });

    test("should route to callback handler", async () => {
      const event = {
        userId: BigInt(ownerId),
        peer: { className: "PeerUser", userId: BigInt(ownerId) },
        data: Buffer.from("drive_test"),
        queryId: BigInt(1),
        className: "UpdateBotCallbackQuery"
      };

      mockAuthGuard.getRole.mockResolvedValue("owner");
      await Dispatcher.handle(event);
      expect(mockDriveConfigFlow.handleCallback).toHaveBeenCalled();
    });

    test("should route to message handler", async () => {
      const event = {
        message: {
          id: 1,
          message: "/drive",
          fromId: { userId: BigInt(ownerId) },
          peerId: { userId: BigInt(ownerId) },
          className: "Message"
        },
        className: "UpdateNewMessage"
      };

      mockAuthGuard.getRole.mockResolvedValue("owner");
      await Dispatcher.handle(event);
      expect(mockDriveConfigFlow.sendDriveManager).toHaveBeenCalled();
    });
  });
});