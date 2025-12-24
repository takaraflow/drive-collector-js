import { jest, describe, test, expect, beforeEach } from '@jest/globals';
import { UIHelper } from '../src/ui/templates';
import { STRINGS, format } from '../src/locales/zh-CN.js';
import { Button } from "telegram/tl/custom/button.js";

// Mock the config module to provide dummy remoteFolder
jest.unstable_mockModule("../src/config/index.js", () => ({
  config: {
    remoteFolder: "/DriveCollectorBot",
  },
}));

jest.unstable_mockModule("../src/locales/zh-CN.js", () => ({
    STRINGS: {
        task: {
            downloading: "📥 正在下载资源...",
            uploading: "📤 **资源拉取完成，正在启动转存...**",
            batch_monitor: "📊 **媒体组转存看板 ({{current}}/{{total}})**\n━━━━━━━━━━━━━━\n{{statusText}}\n━━━━━━━━━━━━━━\n💡 进度条仅显示当前正在处理的文件",
            focus_downloading: "📥 **正在下载**: `{{name}}`",
            focus_uploading: "📤 **正在上传**: `{{name}}`",
            focus_waiting: "🕒 **等待处理**: `{{name}}`",
            focus_completed: "✅ **已完成**: `{{name}}`",
            focus_failed: "❌ **处理失败**: `{{name}}`",
        },
        files: {
            directory_prefix: "📂 **目录**: `{{folder}}`\n\n",
            dir_empty_or_loading: "ℹ️ 目录为空或尚未加载。",
            page_info: "📊 *第 {{current}}/{{total}} 页 | 共 {{count}} 个文件*",
            btn_home: "⏮️",
            btn_prev: "⬅️ 上一页",
            btn_refresh: "🔄 刷新",
            btn_next: "下一页 ➡️",
            btn_end: "⏭️",
            syncing: "🔄 正在同步最新数据...",
            refresh_limit: "🕒 刷新太快了，请 {{seconds}} 秒后再试",
            refresh_success: "刷新成功",
        },
    },
    format: jest.fn((template, vars) => {
      let result = template;
      for (const key in vars) {
        result = result.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), vars[key]);
      }
      return result;
    }),
  }));

jest.unstable_mockModule("telegram/tl/custom/button.js", () => ({
    Button: {
      inline: jest.fn((text, data) => ({ text, data: data.toString() })),
    },
}));

describe('UIHelper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('renderProgress', () => {
    test('renders progress bar correctly', () => {
      const result = UIHelper.renderProgress(50, 100, 'Downloading');
      expect(result).toContain('⏳ **Downloading...**');
      expect(result).toContain('50.0%');
      expect(result).toContain('0.0/0.0 MB');
      expect(result).toContain('█'.repeat(10) + '░'.repeat(10)); // 50% filled
    });

    test('handles zero total', () => {
      const result = UIHelper.renderProgress(0, 0);
      expect(result).toContain('0.0%');
    });

    test('renders full progress', () => {
      const result = UIHelper.renderProgress(100, 100);
      expect(result).toContain('100.0%');
      expect(result).toContain('█'.repeat(20)); // full bar
    });

    test('renders with fileName correctly', () => {
      const result = UIHelper.renderProgress(25, 100, 'Uploading', 'my_long_file_name_by_someone.mp4');
      expect(result).toContain('⏳ **Uploading...**');
      expect(result).toContain('📄 my_long__by_someon.mp4'); // shortened
      expect(result).toContain('25.0%');
      expect(result).toContain('0.0/0.0 MB');
    });
  });

  describe('_shortenFileName', () => {
    test('should return original name if shorter than maxLength', () => {
      expect(UIHelper._shortenFileName('short.txt', 25)).toBe('short.txt');
    });

    test('should shorten regular file names', () => {
      expect(UIHelper._shortenFileName('thisisareallylongfilename.pdf', 20)).toBe('thisisarea...lename.pdf');
    });

    test('should handle file names with _by_ pattern', () => {
      expect(UIHelper._shortenFileName('video_title_by_uploader_long.mp4', 25)).toBe('video_ti_by_upload.mp4');
    });

    test('should handle no extension', () => {
      expect(UIHelper._shortenFileName('thisisareallylongfilename', 15)).toBe('thisisare...lename');
    });
  });

  describe('renderFilesPage', () => {
    const mockFiles = [
      { Name: 'file1.mp4', Size: 104857600, ModTime: '2023-01-01T12:00:00Z' }, // 100MB
      { Name: 'document.pdf', Size: 5242880, ModTime: '2023-01-02T13:00:00Z' }, // 5MB
      { Name: 'archive.zip', Size: 1048576000, ModTime: '2023-01-03T14:00:00Z' }, // 1GB
      { Name: 'image.jpg', Size: 2097152, ModTime: '2023-01-04T15:00:00Z' }, // 2MB
      { Name: 'video.mkv', Size: 209715200, ModTime: '2023-01-05T16:00:00Z' }, // 200MB
      { Name: 'another.mp4', Size: 314572800, ModTime: '2023-01-06T17:00:00Z' }, // 300MB
      { Name: 'last.txt', Size: 1024, ModTime: '2023-01-07T18:00:00Z' }, // 1KB
    ];

    test('renders first page correctly', () => {
      const { text, buttons } = UIHelper.renderFilesPage(mockFiles, 0, 6, false);

      expect(text).toContain("📂 **目录**: `/DriveCollectorBot`");
      expect(text).toContain('🎞️ **file1.mp4**\n> `100.00 MB` | `2023-01-01 12:00`');
      expect(text).toContain("📊 *第 1/2 页 | 共 7 个文件*");
      expect(buttons[0][0].text).toBe('🚫'); // Home button disabled
      expect(buttons[0][1].text).toBe('🚫'); // Prev button disabled
      expect(buttons[0][2].text).toBe('🔄 刷新');
      expect(buttons[0][3].text).toBe('下一页 ➡️');
      expect(buttons[0][4].text).toBe('⏭️');
    });

    test('renders second page correctly', () => {
      const { text, buttons } = UIHelper.renderFilesPage(mockFiles, 1, 6, false);

      expect(text).toContain('📄 **last.txt**\n> `0.00 MB` | `2023-01-07 18:00`');
      expect(text).toContain("📊 *第 2/2 页 | 共 7 个文件*");
      expect(buttons[0][0].text).toBe('⏮️'); // Home button enabled
      expect(buttons[0][1].text).toBe('⬅️ 上一页');
      expect(buttons[0][3].text).toBe('🚫'); // Next button disabled
      expect(buttons[0][4].text).toBe('🚫'); // End button disabled
    });

    test('handles empty file list', () => {
      const { text, buttons } = UIHelper.renderFilesPage([], 0, 6, false);
      expect(text).toContain("ℹ️ 目录为空或尚未加载。");
      expect(text).toContain("📊 *第 1/1 页 | 共 {{count}} 个文件*");
      expect(buttons[0][0].text).toBe('🚫');
      expect(buttons[0][1].text).toBe('🚫');
      expect(buttons[0][3].text).toBe('🚫');
      expect(buttons[0][4].text).toBe('🚫');
    });

    test('shows syncing message when isLoading is true', () => {
      const { text } = UIHelper.renderFilesPage([], 0, 6, true);
      expect(text).toContain("🔄 _🔄 正在同步最新数据..._");
    });
  });

  describe('renderBatchMonitor', () => {
    const mockTasks = [
      { file_name: 'file1.mp4', status: 'completed' },
      { file_name: 'file2.mp4', status: 'downloading' },
      { file_name: 'file3.mp4', status: 'queued' },
      { file_name: 'file4.mp4', status: 'failed' },
    ];

    test('renders batch monitor correctly', () => {
      const mockFocusTask = { fileName: 'file2.mp4' };
      const { text } = UIHelper.renderBatchMonitor(mockTasks, mockFocusTask, 'downloading', 50, 100);
      expect(text).toContain("📊 **媒体组转存看板 (1/4)**");
      expect(text).toContain('✅ file1.mp4');
      expect(text).toContain('🔄 file2.mp4 [50%]');
      expect(text).toContain('🕒 file3.mp4');
      expect(text).toContain('❌ file4.mp4');
    });

    test('shows completed status for focus task', () => {
      const mockFocusTask = { fileName: 'file1.mp4' };
      const { text } = UIHelper.renderBatchMonitor(mockTasks, mockFocusTask, 'completed');
      expect(text).toContain('✅ file1.mp4 (完成)');
    });

    test('shows failed status for focus task', () => {
      const mockFocusTask = { fileName: 'file4.mp4' };
      const { text } = UIHelper.renderBatchMonitor(mockTasks, mockFocusTask, 'failed');
      expect(text).toContain('❌ file4.mp4 (失败)');
    });

    test('shows uploading status for focus task', () => {
      const mockFocusTask = { fileName: 'file2.mp4' };
      const { text } = UIHelper.renderBatchMonitor(mockTasks, mockFocusTask, 'uploading', 75, 100);
      expect(text).toContain('🔄 file2.mp4 [75%]');
    });

    test('shows waiting status for non-focus task', () => {
        const mockFocusTask = { fileName: 'file1.mp4' }; // Focus on another task
        const { text } = UIHelper.renderBatchMonitor(mockTasks, mockFocusTask, 'completed');
        expect(text).toContain('🕒 file3.mp4');
    });

    test('handles empty tasks array', () => {
        const { text } = UIHelper.renderBatchMonitor([], {}, 'waiting');
      expect(text).toContain("📊 **媒体组转存看板 ({{current}}/{{total}})**");
        expect(text).not.toContain('━━━━━━━━━━━━━━\n');
    });
  });
});