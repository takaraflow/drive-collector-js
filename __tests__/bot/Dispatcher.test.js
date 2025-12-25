import { vi, describe, test, expect, beforeEach } from "vitest";
import { Api } from "telegram";

// 1. Mock dependencies
vi.mock("../../src/config/index.js", () => ({
  config: {
    ownerId: "123456",
  },
}));

const mockClient = {
  invoke: vi.fn().mockImplementation(() => {
    const p = Promise.resolve();
    p.catch = (fn) => p;
    return p;
  }),
  sendMessage: vi.fn().mockImplementation(() => Promise.resolve({ id: 1 })),
};
vi.mock("../../src/services/telegram.js", () => ({
  client: mockClient,
}));

const mockAuthGuard = {
  getRole: vi.fn(),
  can: vi.fn(),
};
vi.mock("../../src/modules/AuthGuard.js", () => ({
  AuthGuard: mockAuthGuard,
}));

const mockSessionManager = {
  get: vi.fn(),
};
vi.mock("../../src/modules/SessionManager.js", () => ({
  SessionManager: mockSessionManager,
}));

const mockDriveConfigFlow = {
  handleCallback: vi.fn(),
  handleInput: vi.fn(),
  sendDriveManager: vi.fn(),
  handleUnbind: vi.fn(),
};
vi.mock("../../src/modules/DriveConfigFlow.js", () => ({
  DriveConfigFlow: mockDriveConfigFlow,
}));

const mockTaskManager = {
  cancelTask: vi.fn(),
  addTask: vi.fn(),
  addBatchTasks: vi.fn(),
  waitingTasks: [],
  currentTask: null,
};
vi.mock("../../src/core/TaskManager.js", () => ({
  TaskManager: mockTaskManager,
}));

const mockLinkParser = {
  parse: vi.fn(),
};
vi.mock("../../src/core/LinkParser.js", () => ({
  LinkParser: mockLinkParser,
}));

const mockUIHelper = {
  renderFilesPage: vi.fn(() => ({ text: "mock_text", buttons: [] })),
};
vi.mock("../../src/ui/templates.js", () => ({
  UIHelper: mockUIHelper,
}));

const mockCloudTool = {
  listRemoteFiles: vi.fn(),
  isLoading: vi.fn(() => false),
};
vi.mock("../../src/services/rclone.js", () => ({
  CloudTool: mockCloudTool,
}));

const mockSettingsRepository = {
  get: vi.fn(),
};
vi.mock("../../src/repositories/SettingsRepository.js", () => ({
  SettingsRepository: mockSettingsRepository,
}));

const mockDriveRepository = {
  findById: vi.fn(),
  findByUserId: vi.fn(),
};
vi.mock("../../src/repositories/DriveRepository.js", () => ({
  DriveRepository: mockDriveRepository,
}));

const mockTaskRepository = {
  findByUserId: vi.fn(),
};
vi.mock("../../src/repositories/TaskRepository.js", () => ({
  TaskRepository: mockTaskRepository,
}));

// Mock utils
vi.mock("../../src/utils/common.js", () => ({
  safeEdit: vi.fn(),
  escapeHTML: vi.fn((str) => str),
}));

vi.mock("../../src/utils/limiter.js", () => ({
  runBotTask: vi.fn((fn) => fn()),
  runBotTaskWithRetry: vi.fn((fn) => fn()),
  PRIORITY: {
    UI: 20,
    HIGH: 10,
    NORMAL: 0,
    LOW: -10,
    BACKGROUND: -20
  }
}));

// Mock locales
vi.mock("../../src/locales/zh-CN.js", () => ({
  STRINGS: {
    task: { cmd_sent: "sent", task_not_found: "not found" },
    system: { welcome: "welcome" },
    drive: { no_drive_found: "no drive" },
    status: { header: "header", queue_title: "queue", waiting_tasks: "waiting", current_task: "current", system_info: "sys", uptime: "up", service_status: "svc" }
  },
  format: (s) => s,
}));

// Load Dispatcher
const { Dispatcher } = await import("../../src/bot/Dispatcher.js");

describe("Dispatcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  describe("_handleMessage", () => {
    const target = { className: "PeerUser", userId: BigInt(123) };

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
      vi.useFakeTimers();
      mockSessionManager.get.mockResolvedValue(null);
      mockDriveRepository.findByUserId.mockResolvedValue({ id: 1 });

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

      vi.runAllTimers();
      await Promise.resolve();

      expect(mockTaskManager.addBatchTasks).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe("handle", () => {
    const ownerId = "123456";

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