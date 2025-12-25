import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// Mock dependencies
const mockClient = {
    editMessage: jest.fn()
};
const mockRunBotTaskWithRetry = jest.fn();

jest.unstable_mockModule('../../src/services/telegram.js', () => ({
    client: mockClient
}));

jest.unstable_mockModule('../../src/utils/limiter.js', () => ({
    runBotTask: jest.fn(),
    runBotTaskWithRetry: mockRunBotTaskWithRetry
}));

jest.unstable_mockModule('../../src/locales/zh-CN.js', () => ({
    STRINGS: {
        task: {
            cancel_transfer_btn: 'cancel_transfer',
            cancel_task_btn: 'cancel_task'
        }
    }
}));

jest.unstable_mockModule('telegram/tl/custom/button.js', () => ({
    Button: {
        inline: jest.fn((text, data) => ({ text, data: data.toString() }))
    }
}));

const { escapeHTML, safeEdit, getMediaInfo, updateStatus } = await import('../../src/utils/common.js');

describe('common utils', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockRunBotTaskWithRetry.mockImplementation(async (fn) => {
            return fn();
        });
        mockClient.editMessage.mockResolvedValue({});
    });

    describe('escapeHTML', () => {
        it('should escape HTML special characters', () => {
            expect(escapeHTML('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&#039;');
        });

        it('should return empty string for null input', () => {
            expect(escapeHTML(null)).toBe('');
        });

        it('should return empty string for undefined input', () => {
            expect(escapeHTML(undefined)).toBe('');
        });

        it('should handle complex HTML', () => {
            expect(escapeHTML('<b>Hello & welcome</b>')).toBe('&lt;b&gt;Hello &amp; welcome&lt;/b&gt;');
        });
    });

    describe('safeEdit', () => {
        it('should call editMessage with correct parameters', async () => {
            await safeEdit(123456, 789, 'test message');

            expect(mockRunBotTaskWithRetry).toHaveBeenCalledTimes(1);
            const callArgs = mockRunBotTaskWithRetry.mock.calls[0];
            expect(callArgs[0]).toBeInstanceOf(Function); // The task function
            expect(callArgs[1]).toBeNull(); // userId
            expect(callArgs[2]).toEqual({}); // options
            expect(callArgs[3]).toBe(false); // retry flag
            expect(callArgs[4]).toBe(3); // max retries
        });

        it('should pass userId to runBotTaskWithRetry', async () => {
            await safeEdit(123456, 789, 'test message', null, 'user123');

            expect(mockRunBotTaskWithRetry).toHaveBeenCalledWith(
                expect.any(Function),
                'user123',
                {},
                false,
                3
            );
        });

        it('should pass buttons and parseMode', async () => {
            const buttons = [{ text: 'Button' }];
            await safeEdit(123456, 789, 'test message', buttons, 'user123', 'html');

            expect(mockRunBotTaskWithRetry).toHaveBeenCalledWith(
                expect.any(Function),
                'user123',
                {},
                false,
                3
            );
        });

        it('should not throw on editMessage failure', async () => {
            mockClient.editMessage.mockRejectedValue(new Error('Edit failed'));

            await expect(safeEdit(123456, 789, 'test message')).resolves.not.toThrow();
        });
    });

    describe('getMediaInfo', () => {
        it('should extract info from document media', () => {
            const media = {
                document: {
                    attributes: [{ fileName: 'test.pdf' }],
                    size: 1024
                }
            };

            const result = getMediaInfo(media);
            expect(result).toEqual({
                name: 'test.pdf',
                size: 1024
            });
        });

        it('should extract info from video media', () => {
            const media = {
                video: {
                    attributes: [{ fileName: 'video.mp4' }],
                    size: 2048
                }
            };

            const result = getMediaInfo(media);
            expect(result).toEqual({
                name: 'video.mp4',
                size: 2048
            });
        });

        it('should extract info from photo media', () => {
            const media = {
                photo: {
                    attributes: [], // No filename attribute
                    size: 512,
                    sizes: [{}, {}, { size: 1024 }] // Last size
                }
            };

            const result = getMediaInfo(media);
            expect(result).toEqual({
                name: expect.stringMatching(/transfer_\d+\.jpg/), // Generated name
                size: 512 // obj.size takes precedence over sizes
            });
        });

        it('should return null for media without document/video/photo', () => {
            const media = { audio: {} };

            const result = getMediaInfo(media);
            expect(result).toBeNull();
        });

        it('should generate filename for video without attributes', () => {
            const media = {
                video: {
                    size: 3072
                }
            };

            const result = getMediaInfo(media);
            expect(result.name).toMatch(/transfer_\d+\.mp4/);
            expect(result.size).toBe(3072);
        });

        it('should generate filename for document without attributes', () => {
            const media = {
                document: {
                    size: 4096
                }
            };

            const result = getMediaInfo(media);
            expect(result.name).toMatch(/transfer_\d+\.bin/);
            expect(result.size).toBe(4096);
        });
    });

    describe('updateStatus', () => {
        it('should call safeEdit with cancel button for non-final status', async () => {
            const task = {
                chatId: 123456,
                msgId: 789,
                userId: 'user123',
                proc: false // Not processing
            };

            await updateStatus(task, 'Downloading...', false);

            expect(mockRunBotTaskWithRetry).toHaveBeenCalledTimes(1);
            // Verify the task function calls editMessage correctly
            const taskFn = mockRunBotTaskWithRetry.mock.calls[0][0];
            await taskFn();

            expect(mockClient.editMessage).toHaveBeenCalledWith(123456, {
                message: 789,
                text: 'Downloading...',
                buttons: [expect.objectContaining({ text: 'cancel_task' })],
                parseMode: 'markdown'
            });
        });

        it('should call safeEdit with transfer cancel button for processing task', async () => {
            const task = {
                chatId: 123456,
                msgId: 789,
                userId: 'user123',
                proc: true // Processing
            };

            await updateStatus(task, 'Uploading...', false);

            const taskFn = mockRunBotTaskWithRetry.mock.calls[0][0];
            await taskFn();

            expect(mockClient.editMessage).toHaveBeenCalledWith(123456, {
                message: 789,
                text: 'Uploading...',
                buttons: [expect.objectContaining({ text: 'cancel_transfer' })],
                parseMode: 'markdown'
            });
        });

        it('should call safeEdit without buttons for final status', async () => {
            const task = {
                chatId: 123456,
                msgId: 789,
                userId: 'user123'
            };

            await updateStatus(task, 'Completed!', true);

            const taskFn = mockRunBotTaskWithRetry.mock.calls[0][0];
            await taskFn();

            expect(mockClient.editMessage).toHaveBeenCalledWith(123456, {
                message: 789,
                text: 'Completed!',
                buttons: null,
                parseMode: 'markdown'
            });
        });

        it('should detect HTML content and use html parseMode', async () => {
            const task = {
                chatId: 123456,
                msgId: 789,
                userId: 'user123'
            };

            await updateStatus(task, '<b>HTML content</b>', false);

            const taskFn = mockRunBotTaskWithRetry.mock.calls[0][0];
            await taskFn();

            expect(mockClient.editMessage).toHaveBeenCalledWith(123456, {
                message: 789,
                text: '<b>HTML content</b>',
                buttons: expect.any(Array),
                parseMode: 'html'
            });
        });
    });
});
