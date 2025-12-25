import { jest, describe, test, expect, beforeEach } from "@jest/globals";

// Mock utils/common
jest.unstable_mockModule("../../src/utils/common.js", () => ({
    escapeHTML: jest.fn(str => str)
}));

// Mock locales
jest.unstable_mockModule("../../src/locales/zh-CN.js", () => ({
    STRINGS: {
        task: {
            downloading: "Downloading",
            batch_monitor: "📊 <b>媒体组转存看板 ({{current}}/{{total}})</b>\n━━━━━━━━━━━━━━\n{{statusText}}\n━━━━━━━━━━━━━━\n💡 进度条仅显示当前正在处理的文件"
        },
        files: {
            dir_empty_or_loading: "ℹ️ 目录为空或尚未加载。"
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
    }
}));

// 导入 UIHelper
const { UIHelper } = await import("../../src/ui/templates.js");

describe("UIHelper", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("renderProgress", () => {
        test("should render progress with correct format", () => {
            const result = UIHelper.renderProgress(52428800, 104857600, "Downloading", "test.mp4"); // 50MB of 100MB

            expect(result).toContain("Downloading");
            expect(result).toContain("test.mp4");
            expect(result).toContain("50.0%");
            expect(result).toContain("[██████████░░░░░░░░░░]");
            expect(result).toContain("50.0/100.0 MB");
        });

        test("should handle zero values", () => {
            const result = UIHelper.renderProgress(0, 0, "Processing", "file.txt");

            expect(result).toContain("Processing");
            expect(result).toContain("file.txt");
            expect(result).toContain("0.0%");
            expect(result).toContain("[░░░░░░░░░░░░░░░░░░░░]");
        });

        test("should handle large files", () => {
            const result = UIHelper.renderProgress(1073741824, 2147483648, "Downloading", "large.mp4"); // 1GB of 2GB

            expect(result).toContain("50.0%");
            expect(result).toContain("1024.0/2048.0 MB");
        });
    });

    describe("renderBatchMonitor", () => {
        test("should render batch monitor with correct format", () => {
            const tasks = [
                { id: "task1", file_name: "file1.mp4", status: "downloading", created_at: "2024-01-01T00:00:00Z" },
                { id: "task2", file_name: "file2.mp4", status: "queued", created_at: "2024-01-01T00:01:00Z" },
                { id: "task3", file_name: "file3.mp4", status: "completed", created_at: "2024-01-01T00:02:00Z" }
            ];
            const currentTask = { id: "task1", file_name: "file1.mp4", status: "downloading" };

            const result = UIHelper.renderBatchMonitor(tasks, currentTask, "downloading", 50, 100);

            expect(result.text).toContain("媒体组转存看板");
            expect(result.text).toContain("file1.mp4");
            expect(result.text).toContain("file2.mp4");
            expect(result.text).toContain("file3.mp4");
            expect(result.text).toContain("🔄 file1.mp4 [50%]");
            expect(result.text).toContain("🕒 file2.mp4 (等待中)");
            expect(result.text).toContain("✅ file3.mp4 (完成)");
        });

        test("should render different status emojis correctly", () => {
            const tasks = [
                { id: "task1", file_name: "file1.mp4", status: "downloading", created_at: "2024-01-01T00:00:00Z" },
                { id: "task2", file_name: "file2.mp4", status: "uploading", created_at: "2024-01-01T00:01:00Z" },
                { id: "task3", file_name: "file3.mp4", status: "completed", created_at: "2024-01-01T00:02:00Z" },
                { id: "task4", file_name: "file4.mp4", status: "failed", created_at: "2024-01-01T00:03:00Z" },
                { id: "task5", file_name: "file5.mp4", status: "cancelled", created_at: "2024-01-01T00:04:00Z" }
            ];
            const currentTask = { id: "task1", file_name: "file1.mp4", status: "downloading" };

            const result = UIHelper.renderBatchMonitor(tasks, currentTask, "downloading", 0, 0);

            expect(result.text).toContain("🔄 file1.mp4 (下载中)");
            expect(result.text).toContain("🕒 file2.mp4 (上传中)");
            expect(result.text).toContain("✅ file3.mp4 (完成)");
            expect(result.text).toContain("❌ file4.mp4 (失败)");
            expect(result.text).toContain("🚫 file5.mp4 (已取消)");
        });

        test("should handle empty task list", () => {
            const tasks = [];
            const currentTask = null;

            const result = UIHelper.renderBatchMonitor(tasks, currentTask, "downloading", 0, 0);

            expect(result.text).toContain("媒体组转存看板 (0/0)");
            expect(result.text).toContain("目录为空或尚未加载");
        });

        test("should limit output length for large task lists", () => {
            const tasks = Array.from({ length: 100 }, (_, i) => ({
                id: `task${i}`,
                file_name: `file${i}.mp4`,
                status: "queued",
                created_at: "2024-01-01T00:00:00Z"
            }));
            const currentTask = { id: "task0", file_name: "file0.mp4", status: "downloading" };

            const result = UIHelper.renderBatchMonitor(tasks, currentTask, "downloading", 0, 0);

            expect(result.text.length).toBeLessThan(4096); // Telegram limit
        });
    });

    describe("Progress Bar Edge Cases", () => {
        test("should handle negative current values", () => {
            const result = UIHelper.renderProgress(-100, 1000, "Test", "file.mp4");

            expect(result).toContain("[░░░░░░░░░░░░░░░░░░░░]");
            expect(result).toContain("0.0%");
        });

        test("should handle current > total", () => {
            const result = UIHelper.renderProgress(200, 100, "Test", "file.mp4");

            expect(result).toContain("[████████████████████]");
            expect(result).toContain("200.0%");
        });

        test("should handle zero total with non-zero current", () => {
            const result = UIHelper.renderProgress(100, 0, "Test", "file.mp4");

            expect(result).toContain("[████████████████████]");
            expect(result).toContain("10000.0%"); // (100 / 1) * 100 due to (total || 1)
        });
    });

    describe("File Name Shortening", () => {
        test("should shorten long filenames", () => {
            const result = UIHelper.renderProgress(50, 100, "Test", "very_long_filename_that_should_be_shortened.mp4");

            expect(result).toContain("very_long_fil...hortened.mp4");
        });

        test("should handle Telegram-style filenames", () => {
            const result = UIHelper.renderProgress(50, 100, "Test", "Some Movie Name_by_channel_name.mp4");

            expect(result).toContain("Some Mov_by_channe.mp4");
        });
    });

    describe("generateProgressBar", () => {
        test("should generate correct progress bar for 50%", () => {
            const result = UIHelper.generateProgressBar(50, 100);
            expect(result).toBe("[██████████░░░░░░░░░░] 50%");
        });

        test("should generate correct progress bar for 0%", () => {
            const result = UIHelper.generateProgressBar(0, 100);
            expect(result).toBe("[░░░░░░░░░░░░░░░░░░░░] 0%");
        });

        test("should generate correct progress bar for 100%", () => {
            const result = UIHelper.generateProgressBar(100, 100);
            expect(result).toBe("[████████████████████] 100%");
        });

        test("should handle zero total", () => {
            const result = UIHelper.generateProgressBar(50, 0);
            expect(result).toBe("");
        });

        test("should handle negative total", () => {
            const result = UIHelper.generateProgressBar(50, -10);
            expect(result).toBe("");
        });

        test("should round percentage correctly", () => {
            const result = UIHelper.generateProgressBar(1, 3);
            expect(result).toBe("[███████░░░░░░░░░░░░░] 33%");
        });

        test("should handle custom bar length", () => {
            const result = UIHelper.generateProgressBar(50, 100, 10);
            expect(result).toBe("[█████░░░░░] 50%");
        });

        test("should handle very small percentages", () => {
            const result = UIHelper.generateProgressBar(1, 1000);
            expect(result).toBe("[░░░░░░░░░░░░░░░░░░░░] 0%");
        });

        test("should handle very large percentages", () => {
            const result = UIHelper.generateProgressBar(150, 100);
            expect(result).toBe("[████████████████████] 150%");
        });
    });

    describe("renderBatchMonitor with Progress Bar", () => {
        test("should show progress bar when downloading with progress", () => {
            const tasks = [
                { id: "task1", file_name: "file1.mp4", status: "completed" },
                { id: "task2", file_name: "file2.mp4", status: "downloading" },
                { id: "task3", file_name: "file3.mp4", status: "waiting" }
            ];
            const currentTask = { id: "task2" };

            const result = UIHelper.renderBatchMonitor(tasks, currentTask, "downloading", 52428800, 104857600); // 50MB of 100MB

            expect(result.text).toContain("🔄 file2.mp4 [50%]");
            expect(result.text).toContain("[██████████░░░░░░░░░░] 50%");
            expect(result.text).toContain("💡 进度条仅显示当前正在处理的文件");
            expect(result.text).not.toContain("━━━━━━━━━━━━━━\n💡 进度条仅显示当前正在处理的文件");
        });

        test("should show progress bar when uploading with progress", () => {
            const tasks = [
                { id: "task1", file_name: "file1.mp4", status: "completed" },
                { id: "task2", file_name: "file2.mp4", status: "uploading" }
            ];
            const currentTask = { id: "task2" };

            const result = UIHelper.renderBatchMonitor(tasks, currentTask, "uploading", 26214400, 52428800); // 25MB of 50MB

            expect(result.text).toContain("🔄 file2.mp4 [50%]");
            expect(result.text).toContain("[██████████░░░░░░░░░░] 50%");
        });

        test("should not show progress bar when no progress data", () => {
            const tasks = [
                { id: "task1", file_name: "file1.mp4", status: "completed" },
                { id: "task2", file_name: "file2.mp4", status: "downloading" }
            ];
            const currentTask = { id: "task2" };

            const result = UIHelper.renderBatchMonitor(tasks, currentTask, "downloading", 0, 0);

            expect(result.text).toContain("🔄 file2.mp4 (下载中)");
            expect(result.text).toContain("━━━━━━━━━━━━━━\n💡 进度条仅显示当前正在处理的文件");
            expect(result.text).not.toContain("[");
        });

        test("should not show progress bar when total is zero", () => {
            const tasks = [
                { id: "task1", file_name: "file1.mp4", status: "completed" },
                { id: "task2", file_name: "file2.mp4", status: "downloading" }
            ];
            const currentTask = { id: "task2" };

            const result = UIHelper.renderBatchMonitor(tasks, currentTask, "downloading", 52428800, 0);

            expect(result.text).toContain("🔄 file2.mp4 (下载中)");
            expect(result.text).toContain("━━━━━━━━━━━━━━\n💡 进度条仅显示当前正在处理的文件");
            expect(result.text).not.toContain("[");
        });

        test("should not show progress bar for non-active statuses", () => {
            const tasks = [
                { id: "task1", file_name: "file1.mp4", status: "completed" },
                { id: "task2", file_name: "file2.mp4", status: "waiting" }
            ];
            const currentTask = { id: "task2" };

            const result = UIHelper.renderBatchMonitor(tasks, currentTask, "waiting", 52428800, 104857600);

            expect(result.text).toContain("🕒 file2.mp4 (等待中)");
            expect(result.text).toContain("━━━━━━━━━━━━━━\n💡 进度条仅显示当前正在处理的文件");
            expect(result.text).not.toContain("[");
        });

        test("should handle progress bar with different percentages", () => {
            const tasks = [
                { id: "task1", file_name: "file1.mp4", status: "downloading" }
            ];
            const currentTask = { id: "task1" };

            // Test 25%
            const result25 = UIHelper.renderBatchMonitor(tasks, currentTask, "downloading", 26214400, 104857600);
            expect(result25.text).toContain("[█████░░░░░░░░░░░░░░░] 25%");

            // Test 75%
            const result75 = UIHelper.renderBatchMonitor(tasks, currentTask, "downloading", 78643200, 104857600);
            expect(result75.text).toContain("[███████████████░░░░░] 75%");

            // Test 100%
            const result100 = UIHelper.renderBatchMonitor(tasks, currentTask, "downloading", 104857600, 104857600);
            expect(result100.text).toContain("[████████████████████] 100%");
        });
    });
});