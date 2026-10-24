import { describe, it, expect, vi, beforeEach } from "vitest";

const mockClient = {
    sendMessage: vi.fn().mockResolvedValue({ id: 999 }),
    editMessage: vi.fn().mockResolvedValue({ id: 999 }),
    deleteMessages: vi.fn().mockResolvedValue({}),
    invoke: vi.fn().mockResolvedValue({})
};
const mockAuthGuard = {
    can: vi.fn(),
    getRole: vi.fn().mockResolvedValue("user")
};
const mockSessionManager = {
    start: vi.fn(),
    get: vi.fn(),
    clear: vi.fn()
};
const mockTaskManager = {
    addExternalUrlTask: vi.fn().mockResolvedValue("task-soc-1")
};
const mockDriveRepository = {
    getDefaultDrive: vi.fn().mockResolvedValue({ id: "drive-1", type: "mega" }),
    findByUserId: vi.fn().mockResolvedValue([{ id: "drive-1", type: "mega" }])
};
const mockSafeEdit = vi.fn();
const mockParseSocialMedia = vi.fn();

vi.mock("../../src/services/telegram.js", () => ({
    client: mockClient,
    isClientActive: vi.fn(() => true)
}));
vi.mock("../../src/modules/AuthGuard.js", () => ({ AuthGuard: mockAuthGuard }));
vi.mock("../../src/modules/SessionManager.js", () => ({ SessionManager: mockSessionManager }));
vi.mock("../../src/processor/TaskManager.js", () => ({ TaskManager: mockTaskManager }));
vi.mock("../../src/repositories/DriveRepository.js", () => ({ DriveRepository: mockDriveRepository }));
vi.mock("../../src/repositories/SettingsRepository.js", () => ({ SettingsRepository: { get: vi.fn().mockResolvedValue("public") } }));
vi.mock("../../src/repositories/TaskRepository.js", () => ({ TaskRepository: {} }));
vi.mock("../../src/repositories/ApiKeyRepository.js", () => ({ ApiKeyRepository: {} }));
vi.mock("../../src/processor/LinkParser.js", () => ({ LinkParser: { parse: vi.fn().mockResolvedValue(null) } }));
vi.mock("../../src/processor/SocialMediaParser.js", async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        parseSocialMedia: mockParseSocialMedia
    };
});
vi.mock("../../src/utils/common.js", () => ({
    safeEdit: mockSafeEdit,
    escapeHTML: (value) => String(value),
    formatBytes: (bytes) => `${bytes} B`
}));
vi.mock("../../src/utils/limiter.js", () => ({
    runBotTask: vi.fn((fn) => fn()),
    runBotTaskWithRetry: vi.fn((fn) => fn()),
    PRIORITY: { UI: 10 }
}));
vi.mock("../../src/config/index.js", () => ({
    getConfig: vi.fn().mockReturnValue({
        ownerId: "owner",
        nodeEnv: "test",
        remoteFolder: "remote",
        externalDownload: { timeoutMs: 30000 }
    })
}));
vi.mock("../../src/modules/DriveConfigFlow.js", () => ({ DriveConfigFlow: {} }));
vi.mock("../../src/ui/templates.js", () => ({ UIHelper: {} }));
vi.mock("../../src/services/rclone.js", () => ({ CloudTool: {} }));
vi.mock("../../src/utils/NetworkDiagnostic.js", () => ({ NetworkDiagnostic: {} }));
vi.mock("../../src/services/InstanceCoordinator.js", () => ({
    instanceCoordinator: { getInstanceId: vi.fn(() => "i1"), hasLock: vi.fn().mockResolvedValue(true), isLeader: true }
}));
vi.mock("../../src/services/CacheService.js", () => ({ cache: {} }));
vi.mock("../../src/services/QueueService.js", () => ({ queueService: {} }));
vi.mock("../../src/utils/LocalCache.js", () => ({ localCache: {} }));
vi.mock("../../src/services/MediaGroupBuffer.js", () => ({ default: { restore: vi.fn(), add: vi.fn() } }));
vi.mock("../../src/services/logger/index.js", () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        withModule: vi.fn().mockReturnThis(),
        withContext: vi.fn().mockReturnThis()
    }
}));

const { Dispatcher } = await import("../../src/dispatcher/Dispatcher.js");

describe("Dispatcher Social Media Transfer", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockAuthGuard.can.mockImplementation(async (userId, perm) => {
            if (perm === "task:create") return true;
            if (perm === "external_link:create") return false; // regular user!
            return true;
        });
    });

    it("allows regular user with task:create to parse and transfer social media links", async () => {
        mockParseSocialMedia.mockResolvedValue({
            platform: "X",
            title: "Super crisp 4K tweet",
            author: "CoolCreator",
            originalUrl: "https://x.com/creator/status/12345",
            media: [
                {
                    type: "video",
                    url: "https://video.twimg.com/best_quality_1080p.mp4",
                    quality: "2176k",
                    fileName: "[X] CoolCreator - Super crisp 4K tweet_12345.mp4",
                    fileSize: 15000000,
                    platform: "X"
                }
            ]
        });

        const handled = await Dispatcher._handleLinks(
            "chat-1",
            "regular-user-123",
            "Please transfer this: https://x.com/creator/status/12345",
            { id: "drive-1", type: "mega" }
        );

        expect(handled).toBe(true);
        expect(mockParseSocialMedia).toHaveBeenCalledWith("https://x.com/creator/status/12345");
        expect(mockTaskManager.addExternalUrlTask).toHaveBeenCalledTimes(1);
        expect(mockTaskManager.addExternalUrlTask).toHaveBeenCalledWith(
            "chat-1",
            expect.objectContaining({
                url: "https://video.twimg.com/best_quality_1080p.mp4",
                fileName: "[X] CoolCreator - Super crisp 4K tweet_12345.mp4",
                quality: "2176k",
                platform: "X"
            }),
            "regular-user-123"
        );
    });

    it("prompts user to bind drive if no drive is bound", async () => {
        const sendBindHintSpy = vi.spyOn(Dispatcher, "_sendBindHint").mockResolvedValue();

        const handled = await Dispatcher._handleLinks(
            "chat-1",
            "regular-user-123",
            "https://v.douyin.com/abc1234/",
            null // No bound drive
        );

        expect(handled).toBe(true);
        expect(sendBindHintSpy).toHaveBeenCalledWith("chat-1", "regular-user-123");
        expect(mockTaskManager.addExternalUrlTask).not.toHaveBeenCalled();
    });

    it("handles multiple media items in a photo carousel or album", async () => {
        mockParseSocialMedia.mockResolvedValue({
            platform: "TikTok",
            title: "Photo dump",
            author: "Photographer",
            originalUrl: "https://www.tiktok.com/@user/video/55555",
            media: [
                {
                    type: "photo",
                    url: "https://p3.douyinpic.com/orig1.jpg",
                    quality: "original",
                    fileName: "[TikTok] Photographer - 55555_1.jpg",
                    platform: "TikTok"
                },
                {
                    type: "photo",
                    url: "https://p3.douyinpic.com/orig2.jpg",
                    quality: "original",
                    fileName: "[TikTok] Photographer - 55555_2.jpg",
                    platform: "TikTok"
                }
            ]
        });

        const handled = await Dispatcher._handleLinks(
            "chat-1",
            "user-1",
            "https://www.tiktok.com/@user/video/55555",
            { id: "drive-1" }
        );

        expect(handled).toBe(true);
        expect(mockTaskManager.addExternalUrlTask).toHaveBeenCalledTimes(2);
    });

    it("warns when more than 5 social links are sent at once", async () => {
        mockParseSocialMedia.mockResolvedValue({
            platform: "X",
            title: "Post",
            media: [{ type: "video", url: "https://vid.mp4", fileName: "vid.mp4" }]
        });

        const text = `
            https://x.com/a/status/1
            https://x.com/b/status/2
            https://x.com/c/status/3
            https://x.com/d/status/4
            https://x.com/e/status/5
            https://x.com/f/status/6
        `;

        const handled = await Dispatcher._handleLinks("chat-1", "user-1", text, { id: "drive-1" });
        expect(handled).toBe(true);
        expect(mockClient.sendMessage).toHaveBeenCalledWith(
            "chat-1",
            expect.objectContaining({
                message: expect.stringContaining("最多处理 5 个媒体链接")
            })
        );
        // Only first 5 processed
        expect(mockParseSocialMedia).toHaveBeenCalledTimes(5);
    });
});
