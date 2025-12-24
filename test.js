import { UIHelper } from './src/ui/templates.js';
import assert from 'assert';

console.log('Running tests...');

// Test UIHelper.renderProgress
const progressResult = UIHelper.renderProgress(50, 100, 'Downloading'); // Use MB values
assert(progressResult.includes('⏳ **Downloading...**'), 'Progress bar should contain title');
assert(progressResult.includes('50.0%'), 'Progress bar should contain percentage');
assert(progressResult.includes('50.0/100.0 MB'), 'Progress bar should contain sizes');
console.log('✓ UIHelper.renderProgress test passed');

// Test UIHelper.renderBatchMonitor
const mockTasks = [
  { file_name: 'file1.mp4', status: 'completed' },
  { file_name: 'file2.mp4', status: 'downloading' },
  { file_name: 'file3.mp4', status: 'completed' },
];
const mockFocusTask = { fileName: 'file2.mp4' };
const monitorResult = UIHelper.renderBatchMonitor(mockTasks, mockFocusTask, 'downloading', 50, 100);
assert(monitorResult.text.includes('📊 **媒体组转存看板 (2/3)**'), 'Monitor should show correct count');
assert(monitorResult.text.includes('✅ `file1.mp4`'), 'Completed files should be marked');
assert(monitorResult.text.includes('📥 **正在下载**: `file2.mp4`'), 'Focus task should show downloading');
console.log('✓ UIHelper.renderBatchMonitor test passed');

console.log('All tests passed! ✅');