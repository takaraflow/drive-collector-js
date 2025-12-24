import { jest, describe, it, expect } from '@jest/globals';

describe('Release AI Script', () => {
    it('should export prepareRelease function', async () => {
        // Import the script
        const { prepareRelease } = await import('../../scripts/release-ai.js');
        expect(typeof prepareRelease).toBe('function');
    });

    it('should execute successfully with mocked dependencies', async () => {
        // Mock dependencies
        const mockExecSync = jest.fn()
            .mockReturnValueOnce('') // git status --porcelain (clean)
            .mockReturnValueOnce(''); // standard-version (success)

        const mockExit = jest.fn();
        const mockConsole = {
            log: jest.fn(),
            error: jest.fn()
        };

        // Import and test
        const { prepareRelease } = await import('../../scripts/release-ai.js');

        await prepareRelease({
            execSync: mockExecSync,
            exit: mockExit,
            console: mockConsole
        });

        expect(mockExecSync).toHaveBeenCalledTimes(2);
        expect(mockConsole.log).toHaveBeenCalledWith('🔍 正在准备版本文件 (不触发提交)...');
        expect(mockExit).not.toHaveBeenCalled();
    });

    it('should exit with error when git has uncommitted changes', async () => {
        // Mock dependencies
        const mockExecSync = jest.fn().mockReturnValue(' M modified-file.js');
        const mockExit = jest.fn();
        const mockConsole = {
            log: jest.fn(),
            error: jest.fn()
        };

        // Import and test
        const { prepareRelease } = await import('../../scripts/release-ai.js');

        await prepareRelease({
            execSync: mockExecSync,
            exit: mockExit,
            console: mockConsole
        });

        expect(mockExecSync).toHaveBeenCalledTimes(1);
        expect(mockConsole.error).toHaveBeenCalledWith('❌ 错误: 请先提交或 stash 当前改动后再发版。');
        expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('should handle command execution errors', async () => {
        // Mock dependencies
        const mockExecSync = jest.fn().mockImplementation(() => {
            throw new Error('Command failed');
        });
        const mockExit = jest.fn();
        const mockConsole = {
            log: jest.fn(),
            error: jest.fn()
        };

        // Import and test
        const { prepareRelease } = await import('../../scripts/release-ai.js');

        await prepareRelease({
            execSync: mockExecSync,
            exit: mockExit,
            console: mockConsole
        });

        expect(mockConsole.error).toHaveBeenCalledWith('❌ 脚本执行失败:', 'Command failed');
        expect(mockExit).toHaveBeenCalledWith(1);
    });
});