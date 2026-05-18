const mockClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 123 }),
    invoke: vi.fn().mockResolvedValue({})
};
const mockUserRepository = {
    listForAdmin: vi.fn(),
    normalizeFilter: vi.fn((filter) => {
        const allowed = new Set(["all", "active", "admin", "banned", "nodrive"]);
        return allowed.has(filter) ? filter : "all";
    })
};
const mockAuthGuard = {
    can: vi.fn()
};
const mockUIHelper = {
    renderAdminUsers: vi.fn().mockReturnValue({ text: "rendered user list", buttons: [] }),
    renderDiagnosisReport: vi.fn(),
    renderTaskQueue: vi.fn()
};
const mockSafeEdit = vi.fn();

vi.mock("../../src/services/telegram.js", () => ({
    client: mockClient,
    isClientActive: vi.fn(() => true)
}));
vi.mock("../../src/repositories/UserRepository.js", () => ({
    UserRepository: mockUserRepository
}));
vi.mock("../../src/modules/AuthGuard.js", () => ({
    AuthGuard: mockAuthGuard
}));
vi.mock("../../src/ui/templates.js", () => ({
    UIHelper: mockUIHelper
}));
vi.mock("../../src/utils/common.js", () => ({
    safeEdit: mockSafeEdit,
    escapeHTML: (value) => String(value),
    formatBytes: (bytes) => `${bytes} B`
}));
vi.mock("../../src/config/index.js", () => ({
    getConfig: vi.fn().mockReturnValue({ ownerId: "owner-1", nodeEnv: "test", remoteFolder: "/Telegram" }),
    config: { ownerId: "owner-1" }
}));
vi.mock("../../src/utils/limiter.js", () => ({
    runBotTask: vi.fn((fn) => fn()),
    runBotTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoTask: vi.fn((fn) => fn()),
    runMtprotoTaskWithRetry: vi.fn((fn) => fn()),
    runMtprotoFileTaskWithRetry: vi.fn((fn) => fn()),
    PRIORITY: { UI: 10, NORMAL: 0, LOW: -10, BACKGROUND: -20 }
}));
vi.mock("../../src/repositories/TaskRepository.js", () => ({
    TaskRepository: {
        getUserQueueOverview: vi.fn().mockResolvedValue({ statusCounts: {}, activeTasks: [], recentTasks: [] }),
        getQueueOverview: vi.fn(),
        getTasksByStatus: vi.fn()
    }
}));
vi.mock("../../src/repositories/DriveRepository.js", () => ({
    DriveRepository: {
        getDefaultDrive: vi.fn(),
        findByUserId: vi.fn()
    }
}));
vi.mock("../../src/modules/SessionManager.js", () => ({ SessionManager: { get: vi.fn(), clear: vi.fn(), start: vi.fn() } }));
vi.mock("../../src/modules/DriveConfigFlow.js", () => ({ DriveConfigFlow: {} }));
vi.mock("../../src/processor/TaskManager.js", () => ({
    TaskManager: { retryTask: vi.fn(), cancelTask: vi.fn(), cancelTasksByMsgId: vi.fn() }
}));
vi.mock("../../src/processor/LinkParser.js", () => ({ LinkParser: {} }));
vi.mock("../../src/processor/ExternalUrlPolicy.js", () => ({
    extractExternalHttpUrls: vi.fn(() => []),
    findUnsupportedExternalLinks: vi.fn(() => []),
    probeExternalUrl: vi.fn(),
    redactUrlForDisplay: vi.fn()
}));
vi.mock("../../src/services/rclone.js", () => ({ CloudTool: {} }));
vi.mock("../../src/repositories/SettingsRepository.js", () => ({ SettingsRepository: {} }));
vi.mock("../../src/repositories/ApiKeyRepository.js", () => ({ ApiKeyRepository: {} }));
vi.mock("../../src/utils/NetworkDiagnostic.js", () => ({ NetworkDiagnostic: { diagnoseAll: vi.fn() } }));
vi.mock("../../src/utils/memoryMonitor.js", () => ({ getMemoryDiagnostics: vi.fn(() => ({})) }));
vi.mock("../../src/services/InstanceCoordinator.js", () => ({
    instanceCoordinator: {
        getInstanceId: vi.fn(() => "test-instance"),
        getActiveInstances: vi.fn().mockResolvedValue([]),
        getInstanceCount: vi.fn().mockResolvedValue(1),
        hasLock: vi.fn().mockResolvedValue(true),
        isLeader: true
    }
}));
vi.mock("../../src/services/CacheService.js", () => ({ cache: { getProviderName: vi.fn(() => "memory"), isFailoverMode: false } }));
vi.mock("../../src/services/QueueService.js", () => ({ queueService: {} }));
vi.mock("../../src/utils/LocalCache.js", () => ({ localCache: {} }));
vi.mock("../../src/services/MediaGroupBuffer.js", () => ({ default: { restore: vi.fn(), add: vi.fn() } }));
vi.mock("../../src/services/logger/index.js", () => {
    const moduleLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), withContext: vi.fn(() => moduleLogger) };
    const logger = { withModule: vi.fn(() => moduleLogger), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return {
        logger,
        default: logger,
        setInstanceIdProvider: vi.fn(),
        enableTelegramConsoleProxy: vi.fn(),
        disableTelegramConsoleProxy: vi.fn(),
        flushLogBuffer: vi.fn(),
        createLogger: vi.fn(() => logger),
        LoggerService: vi.fn()
    };
});

const { Dispatcher } = await import("../../src/dispatcher/Dispatcher.js");

const userListData = {
    filter: "all",
    users: [{ user_id: "user-1", role: "user" }],
    summary: { total: 1, active: 0, admins: 0, banned: 0, noDrive: 1 },
    total: 1,
    page: 0,
    pageSize: 8,
    totalPages: 1
};

const createCallbackEvent = (data) => ({
    data: Buffer.from(data),
    userId: "admin-1",
    msgId: 456,
    peer: "chat-1",
    queryId: "query-1"
});

describe("Dispatcher admin user list", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAuthGuard.can.mockResolvedValue(true);
        mockUserRepository.listForAdmin.mockResolvedValue(userListData);
        mockUIHelper.renderAdminUsers.mockReturnValue({ text: "rendered user list", buttons: [] });
    });

    it("should send placeholder and render the admin user list command", async () => {
        await Dispatcher._handleAdminUsersCommand("chat-1", "admin-1");
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            "chat-1",
            expect.objectContaining({ message: expect.stringContaining("正在查询用户列表") })
        );
        expect(mockUserRepository.listForAdmin).toHaveBeenCalledWith({
            filter: "all",
            page: 0,
            pageSize: 8,
            ownerId: "owner-1"
        });
        expect(mockUIHelper.renderAdminUsers).toHaveBeenCalledWith(userListData);
        expect(mockSafeEdit).toHaveBeenCalledWith("chat-1", 123, "rendered user list", [], "admin-1");
    });

    it("should reject non-admin command access without querying users", async () => {
        mockAuthGuard.can.mockResolvedValue(false);

        await Dispatcher._handleAdminUsersCommand("chat-1", "user-1");

        expect(mockUserRepository.listForAdmin).not.toHaveBeenCalled();
        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            "chat-1",
            expect.objectContaining({ message: expect.stringContaining("无权限") })
        );
    });

    it("should handle repository failures without leaking raw errors", async () => {
        mockUserRepository.listForAdmin.mockRejectedValue(new Error("D1 token expired"));

        await Dispatcher._handleAdminUsersCommand("chat-1", "admin-1");
        await new Promise(resolve => setTimeout(resolve, 20));

        const lastEdit = mockSafeEdit.mock.calls.at(-1);
        expect(lastEdit[2]).toContain("暂时无法查询用户列表");
        expect(lastEdit[2]).not.toContain("D1 token expired");
    });

    it("should edit the current message for admin_users_open callback", async () => {
        const event = createCallbackEvent("admin_users_open");

        await Dispatcher._handleCallback(event, { userId: "admin-1" });

        expect(mockSafeEdit).toHaveBeenNthCalledWith(
            1,
            "admin-1",
            456,
            expect.stringContaining("正在查询用户列表"),
            null,
            "admin-1"
        );
        expect(mockSafeEdit).toHaveBeenLastCalledWith("admin-1", 456, "rendered user list", [], "admin-1");
        expect(mockClient.invoke).toHaveBeenCalled();
    });

    it("should parse filter and page callbacks through the same read model", async () => {
        const answer = vi.fn();

        await Dispatcher._handleAdminUsersCallback(createCallbackEvent("au_refresh_banned_2"), "au_refresh_banned_2", "admin-1", answer);

        expect(mockUserRepository.listForAdmin).toHaveBeenCalledWith({
            filter: "banned",
            page: 2,
            pageSize: 8,
            ownerId: "owner-1"
        });
        expect(mockSafeEdit).toHaveBeenCalledWith("admin-1", 456, "rendered user list", [], "admin-1");
        expect(answer).toHaveBeenCalledWith();
    });

    it("should reject non-admin callbacks without querying users", async () => {
        mockAuthGuard.can.mockResolvedValue(false);
        const answer = vi.fn();

        await Dispatcher._handleAdminUsersCallback(createCallbackEvent("au_active_0"), "au_active_0", "user-1", answer);

        expect(mockUserRepository.listForAdmin).not.toHaveBeenCalled();
        expect(answer).toHaveBeenCalledWith(expect.stringContaining("无权限"));
    });

    it("should route /users text command through the command router", async () => {
        const handled = await Dispatcher._routeTextCommand("chat-1", "admin-1", "/users", { message: "/users" }, null);
        await new Promise(resolve => setTimeout(resolve, 20));

        expect(handled).toBe(true);
        expect(mockUserRepository.listForAdmin).toHaveBeenCalled();
    });
});
