// Mock utils/common
vi.mock("../../src/utils/common.js", async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        escapeHTML: vi.fn(str => str)
    };
});

// Mock config
vi.mock("../../src/config/index.js", () => ({
    config: {
        remoteFolder: "remote_folder"
    },
    getConfig: () => ({
        remoteFolder: "remote_folder"
    })
}));

// Mock CloudTool
vi.mock("../../src/services/rclone.js", () => ({
    CloudTool: {
        _getUploadPath: vi.fn()
    }
}));

// Mock locales
vi.mock("../../src/locales/zh-CN.js", () => ({
    STRINGS: {
        task: {
            batch_monitor: "📊 <b>媒体组转存看板 ({{current}}/{{total}})</b>\n━━━━━━━━━━━━━━\n{{statusText}}\n━━━━━━━━━━━━━━\n💡 进度条仅显示当前正在处理的文件",
            downloading: "正在下载",
            empty_tasks: "暂无任务数据\n💡 提示: 发送文件即可开始转存"
        },
        files: {
            dir_empty_or_loading: "目录为空或尚未加载"
        },
        diagnosis: {
            title: "🔍 <b>系统诊断报告</b>",
            multi_instance_title: "🏗️ <b>多实例状态</b>",
            network_title: "🌐 <b>网络诊断</b>",
            system_resources_title: "💾 <b>系统资源</b>",
            current_instance: "当前实例",
            leader_status: "领导者状态",
            tg_connection: "TG 连接",
            tg_lock_holder: "TG 锁持有",
            active_instances: "活跃实例",
            memory_usage: "内存",
            uptime: "运行",
            connected: "已连接",
            disconnected: "已断开",
            yes: "是",
            no: "否",
            leader: "(👑)",
            no_active_instances: "无活跃实例"
        },
        task: {
            downloading: "Downloading",
            batch_monitor: "📊 <b>媒体组转存看板 ({{current}}/{{total}})</b>\n━━━━━━━━━━━━━━\n{{statusText}}\n━━━━━━━━━━━━━━\n💡 进度条仅显示当前正在处理的文件",
            empty_tasks: "暂无任务数据\n💡 提示: 发送文件即可开始转存"
        },
        files: {
            directory_prefix: "📂 <b>目录</b>: <code>{{folder}}</code>\n\n",
            dir_empty_or_loading: "ℹ️ 目录为空或尚未加载。"
        }
    },
    format: (s, args) => {
        let res = s || "";
        if (args) {
            for (const key in args) {
                res = res.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), args[key] !== undefined && args[key] !== null ? args[key] : `{{${key}}}`);
            }
        }
        return res;
    }
}));

// 导入 UIHelper
const { UIHelper } = await import("../../src/ui/templates.js");

describe("UIHelper", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe("renderProgress", () => {
        test("should render progress with correct format", () => {
            const result = UIHelper.renderProgress(52428800, 104857600, "Downloading", "test.mp4"); // 50MB of 100MB

            expect(result).toContain("Downloading");
            expect(result).toContain("test.mp4");
            expect(result).toContain("50.0%");
            expect(result).toContain("[██████████░░░░░░░░░░]");
            expect(result).toContain("50 MB/100 MB");
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
            expect(result).toContain("1 GB/2 GB");
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
            expect(result.text).toContain("暂无任务数据\n💡 提示: 发送文件即可开始转存");
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
            expect(result.text).toContain("<code>[██████████░░░░░░░░░░] 50%</code>");
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
            expect(result.text).toContain("<code>[██████████░░░░░░░░░░] 50%</code>");
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
            expect(result25.text).toContain("<code>[█████░░░░░░░░░░░░░░░] 25%</code> (25 MB/100 MB)");

            // Test 75%
            const result75 = UIHelper.renderBatchMonitor(tasks, currentTask, "downloading", 78643200, 104857600);
            expect(result75.text).toContain("<code>[███████████████░░░░░] 75%</code> (75 MB/100 MB)");

            // Test 100%
            const result100 = UIHelper.renderBatchMonitor(tasks, currentTask, "downloading", 104857600, 104857600);
            expect(result100.text).toContain("<code>[████████████████████] 100%</code> (100 MB/100 MB)");
        });
    });

    describe("renderDiagnosisReport", () => {
        test("should render diagnosis report with all sections", () => {
            const data = {
                networkResults: {
                    services: {
                        telegram: {
                            status: 'ok',
                            responseTime: '45ms',
                            message: 'Telegram MTProto API 连接正常'
                        },
                        d1: {
                            status: 'error',
                            responseTime: '5000ms',
                            message: 'Cloudflare D1 连接失败: Timeout'
                        }
                    }
                },
                instanceInfo: {
                    currentInstanceId: 'instance-123',
                    isLeader: true,
                    tgActive: true,
                    isTgLeader: true,
                    instanceCount: 2,
                    cacheProvider: 'RedisTLS',
                    cacheFailover: true
                },
                systemResources: {
                    memoryMB: '120MB (100MB/200MB)',
                    uptime: '2h 15m'
                }
            };

            const result = UIHelper.renderDiagnosisReport(data);

            // 验证新格式
            expect(result).toContain("🔍 <b>系统诊断报告</b>");
            expect(result).toContain("━━━━━━━━━━━━━━━━━━━");
            expect(result).toContain("🏗️ <b>多实例状态</b>");
            expect(result).toContain("ID:   instance-123 (👑)");
            expect(result).toContain("TG:   ✅ 已连接 | 🔒 是");
            expect(result).toContain("活跃: 2 个实例");
            expect(result).toContain("Cache: RedisTLS | Failover: 是");
            expect(result).toContain("🌐 <b>网络诊断</b>");
            expect(result).toContain("TG-MT  : ✅ Telegram MTProto API 连接正常 (45ms)");
            expect(result).toContain("DB-D1  : ❌ Cloudflare D1 连接失败: Timeout (5000ms)");
            expect(result).toContain("💾 <b>系统资源</b>");
            expect(result).toContain("内存: 120MB (100MB/200MB)");
            expect(result).toContain("运行: 2h 15m");
            expect(result).toContain("⚠️ 发现 1 个服务异常，请检查网络连接或配置。");
        });

        test("should render diagnosis report with no errors", () => {
            const data = {
                networkResults: {
                    services: {
                        telegram: {
                            status: 'ok',
                            responseTime: '45ms',
                            message: 'Telegram MTProto API 连接正常'
                        },
                        d1: {
                            status: 'ok',
                            responseTime: '120ms',
                            message: 'Cloudflare D1 连接正常'
                        }
                    }
                },
                instanceInfo: {
                    currentInstanceId: 'instance-456',
                    isLeader: false,
                    tgActive: true,
                    isTgLeader: false,
                    instanceCount: 1
                },
                systemResources: {
                    memoryMB: '80MB (60MB/120MB)',
                    uptime: '1h 30m'
                }
            };

            const result = UIHelper.renderDiagnosisReport(data);

            expect(result).toContain("ID:   instance-456");
            expect(result).toContain("TG:   ✅ 已连接 | 🔒 否");
            expect(result).toContain("活跃: 1 个实例");
            expect(result).toContain("TG-MT  : ✅ Telegram MTProto API 连接正常 (45ms)");
            expect(result).toContain("DB-D1  : ✅ Cloudflare D1 连接正常 (120ms)");
            expect(result).toContain("✅ 所有服务运行正常");
        });

        test("should handle missing data gracefully", () => {
            const data = {
                networkResults: null,
                instanceInfo: null,
                systemResources: null
            };

            const result = UIHelper.renderDiagnosisReport(data);

            expect(result).toContain("🔍 <b>系统诊断报告</b>");
            expect(result).toContain("🏗️ <b>多实例状态</b>");
            expect(result).toContain("🌐 <b>网络诊断</b>");
            expect(result).toContain("💾 <b>系统资源</b>");
            expect(result).toContain("数据获取失败");
            expect(result).toContain("网络诊断数据为空");
            expect(result).toContain("系统资源数据为空");
            expect(result).toContain("⚠️ 无法获取完整的诊断信息");
        });

        test("should handle disconnected Telegram", () => {
            const data = {
                networkResults: {
                    services: {}
                },
                instanceInfo: {
                    currentInstanceId: 'instance-789',
                    isLeader: false,
                    tgActive: false,
                    isTgLeader: false,
                    instanceCount: 0
                },
                systemResources: {
                    memoryMB: '50MB (40MB/80MB)',
                    uptime: '30m'
                }
            };

            const result = UIHelper.renderDiagnosisReport(data);

            expect(result).toContain("TG:   ❌ 已断开 | 🔒 否");
            expect(result).toContain("活跃: 0 个实例");
        });

        test("should handle multiple services with different statuses", () => {
            const data = {
                networkResults: {
                    services: {
                        telegram: { status: 'ok', responseTime: '45ms', message: '正常' },
                        bot: { status: 'ok', responseTime: '30ms', message: '正常' },
                        d1: { status: 'error', responseTime: '5000ms', message: '超时' },
                        kv: { status: 'ok', responseTime: '120ms', message: '正常' },
                        rclone: { status: 'ok', responseTime: '10ms', message: '正常' }
                    }
                },
                instanceInfo: {
                    currentInstanceId: 'instance-999',
                    isLeader: false,
                    tgActive: true,
                    isTgLeader: false,
                    instanceCount: 3
                },
                systemResources: {
                    memoryMB: '150MB (120MB/250MB)',
                    uptime: '5h 30m'
                }
            };

            const result = UIHelper.renderDiagnosisReport(data);

            expect(result).toContain("TG-MT  : ✅ 正常 (45ms)");
            expect(result).toContain("TG-BOT : ✅ 正常 (30ms)");
            expect(result).toContain("DB-D1  : ❌ 超时 (5000ms)");
            expect(result).toContain("KV-ST  : ✅ 正常 (120ms)");
            expect(result).toContain("RCLONE : ✅ 正常 (10ms)");
            expect(result).toContain("⚠️ 发现 1 个服务异常，请检查网络连接或配置。");
        });
    });

    describe('renderFilesPage with user paths', () => {
        test('should use default path when userId is null', async () => {
            const { CloudTool } = await import("../../src/services/rclone.js");
            CloudTool._getUploadPath = vi.fn();

            const files = [
                { Name: "movie.mp4", Size: 1000000, ModTime: "2024-01-01T10:00:00Z" }
            ];

            const result = await UIHelper.renderFilesPage(files, 0, 6, false, null);

            expect(result.text).toContain("remote_folder");
            expect(CloudTool._getUploadPath).not.toHaveBeenCalled();
        });

        test('should use user-specific path when userId is provided', async () => {
            const { CloudTool } = await import("../../src/services/rclone.js");
            CloudTool._getUploadPath = vi.fn().mockResolvedValue("/Movies/2024");

            const files = [
                { Name: "movie.mp4", Size: 1000000, ModTime: "2024-01-01T10:00:00Z" }
            ];

            const result = await UIHelper.renderFilesPage(files, 0, 6, false, "user123");

            expect(result.text).toContain("/Movies/2024");
            expect(CloudTool._getUploadPath).toHaveBeenCalledWith("user123");
        });
    });
});