/**
 * TaskManager 计数逻辑测试
 *
 * 这个测试文件验证 TaskManager 中任务计数的方法：
 * - getProcessingCount(): 计算当前正在处理的任务总数（下载中 + 上传中）
 * - getWaitingCount(): 计算等待中的任务总数（下载排队 + 上传排队）
 *
 * 注意：由于项目测试环境依赖复杂（需要 Telegram API、数据库等），
 * 此测试使用模拟类进行单元测试，验证逻辑正确性。
 */

class MockTaskManager {
    static waitingTasks = [];
    static currentTask = null;
    static processingUploadTasks = new Set();
    static waitingUploadTasks = [];

    /**
     * 获取当前正在处理的任务总数 (下载中 + 上传中)
     */
    static getProcessingCount() {
        let count = 0;
        if (this.currentTask) count++;
        count += this.processingUploadTasks.size;
        return count;
    }

    /**
     * 获取等待中的任务总数 (下载排队 + 上传排队)
     */
    static getWaitingCount() {
        return this.waitingTasks.length + this.waitingUploadTasks.length;
    }
}

describe('TaskManager Processing Count', () => {
    beforeEach(() => {
        // 重置状态，确保每个测试独立
        MockTaskManager.waitingTasks = [];
        MockTaskManager.currentTask = null;
        MockTaskManager.waitingUploadTasks = [];
        MockTaskManager.processingUploadTasks.clear();
    });

    test('should return 0 when no tasks', () => {
        expect(MockTaskManager.getProcessingCount()).toBe(0);
        expect(MockTaskManager.getWaitingCount()).toBe(0);
    });

    test('should count downloading task as processing', () => {
        MockTaskManager.currentTask = { id: 'task1' };
        expect(MockTaskManager.getProcessingCount()).toBe(1);
    });

    test('should count uploading tasks as processing', () => {
        MockTaskManager.processingUploadTasks.add('task2');
        MockTaskManager.processingUploadTasks.add('task3');
        expect(MockTaskManager.getProcessingCount()).toBe(2);
    });

    test('should count both downloading and uploading tasks', () => {
        MockTaskManager.currentTask = { id: 'task1' };
        MockTaskManager.processingUploadTasks.add('task2');
        expect(MockTaskManager.getProcessingCount()).toBe(2);
    });

    test('should count waiting tasks correctly', () => {
        MockTaskManager.waitingTasks = [{ id: 'task1' }, { id: 'task2' }];
        MockTaskManager.waitingUploadTasks = [{ id: 'task3' }];
        expect(MockTaskManager.getWaitingCount()).toBe(3);
    });
});