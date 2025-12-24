import { UIHelper } from '../src/ui/templates.js';

describe('UIHelper', () => {
  describe('renderProgress', () => {
    test('renders progress bar correctly', () => {
      const result = UIHelper.renderProgress(50, 100, 'Downloading');
      expect(result).toContain('⏳ **Downloading...**');
      expect(result).toContain('50.0%');
      expect(result).toContain('50.0/100.0 MB');
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
  });

  describe('renderBatchMonitor', () => {
    const mockTasks = [
      { file_name: 'file1.mp4', status: 'completed' },
      { file_name: 'file2.mp4', status: 'downloading' },
      { file_name: 'file3.mp4', status: 'completed' },
    ];

    const mockFocusTask = { fileName: 'file2.mp4' };

    test('renders batch monitor correctly', () => {
      const result = UIHelper.renderBatchMonitor(mockTasks, mockFocusTask, 'downloading', 50, 100);
      expect(result.text).toContain('📊 **媒体组转存看板 (2/3)**');
      expect(result.text).toContain('✅ `file1.mp4`');
      expect(result.text).toContain('📥 **正在下载**: `file2.mp4`');
      expect(result.text).toContain('✅ `file3.mp4`');
    });

    test('shows progress bar for downloading', () => {
      const result = UIHelper.renderBatchMonitor(mockTasks, mockFocusTask, 'downloading', 50, 100);
      expect(result.text).toContain('50.0%');
    });

    test('shows completed status', () => {
      const result = UIHelper.renderBatchMonitor(mockTasks, { fileName: 'file1.mp4' }, 'completed');
      expect(result.text).toContain('✅ **已完成**: `file1.mp4`');
    });
  });
});