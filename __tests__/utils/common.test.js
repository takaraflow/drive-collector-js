// Mock dependencies
const mockClient = {
    editMessage: vi.fn(),
    sendMessage: vi.fn()
};
const mockRunBotTaskWithRetry = vi.fn();

vi.mock('../../src/services/telegram.js', () => ({
    client: mockClient
}));

vi.mock('../../src/utils/limiter.js', () => ({
    runBotTask: vi.fn(),
    runBotTaskWithRetry: mockRunBotTaskWithRetry
}));

vi.mock('../../src/locales/zh-CN.js', () => ({
    STRINGS: {
        task: {
            cancel_transfer_btn: 'cancel_transfer',
            cancel_task_btn: 'cancel_task',
            retry_btn: 'retry'
        }
    }
}));

vi.mock('telegram/tl/custom/button.js', () => ({
    Button: {
        inline: vi.fn((text, data) => ({ text, data: data.toString() }))
    }
}));

const { escapeHTML, safeEdit, getMediaInfo, updateStatus, sanitizeHeaders, __resetSafeEditStateForTests } = await import('../../src/utils/common.js');

describe('common utils', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __resetSafeEditStateForTests();
        mockRunBotTaskWithRetry.mockImplementation(async (fn) => {
            return fn();
        });
        mockClient.editMessage.mockResolvedValue({});
        mockClient.sendMessage.mockResolvedValue({});
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

        it('should report edit failure as false', async () => {
            mockClient.editMessage.mockRejectedValue(new Error('Edit failed'));

            await expect(safeEdit(123456, 789, 'test message')).resolves.toBe(false);
        });

        it('should ignore MESSAGE_NOT_MODIFIED error', async () => {
            const error = new Error('400: MESSAGE_NOT_MODIFIED');
            error.code = 400;
            error.errorMessage = 'MESSAGE_NOT_MODIFIED';
            mockClient.editMessage.mockRejectedValue(error);

            // Using mockRunBotTaskWithRetry implementation from beforeEach which calls the function
            await expect(safeEdit(123456, 789, 'same text')).resolves.not.toThrow();
            
            // Should have called editMessage
            expect(mockClient.editMessage).toHaveBeenCalledTimes(1);
        });

        it('should retry on other errors but eventually not throw', async () => {
            mockClient.editMessage.mockRejectedValue(new Error('Other error'));
            
            await expect(safeEdit(123456, 789, 'test')).resolves.not.toThrow();
            
            // runBotTaskWithRetry handles the retries, here it's called once
            expect(mockRunBotTaskWithRetry).toHaveBeenCalledTimes(1);
        });

        it('should coalesce queued edits for the same message and only apply the latest queued text', async () => {
            let releaseFirstEdit;
            let firstEditStarted;
            const firstEditStartedPromise = new Promise((resolve) => {
                firstEditStarted = resolve;
            });
            mockClient.editMessage
                .mockImplementationOnce(() => new Promise((resolve) => {
                    firstEditStarted();
                    releaseFirstEdit = resolve;
                }))
                .mockResolvedValueOnce({});

            const first = safeEdit(123456, 789, 'old progress');
            await firstEditStartedPromise;
            const second = safeEdit(123456, 789, 'mid progress');
            const third = safeEdit(123456, 789, 'new progress');

            expect(mockRunBotTaskWithRetry).toHaveBeenCalledTimes(1);

            releaseFirstEdit({});
            await first;
            await second;
            await third;

            expect(mockClient.editMessage).toHaveBeenCalledTimes(2);
            expect(mockClient.editMessage).toHaveBeenNthCalledWith(1, 123456, {
                message: 789,
                text: 'old progress',
                buttons: null,
                parseMode: 'html'
            });
            expect(mockClient.editMessage).toHaveBeenNthCalledWith(2, 123456, {
                message: 789,
                text: 'new progress',
                buttons: null,
                parseMode: 'html'
            });
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
                name: expect.stringMatching(/transfer_\d+_[a-z0-9]+\.jpg/), // Generated name with nonce
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
            expect(result.name).toMatch(/transfer_\d+_[a-z0-9]+\.mp4/);
            expect(result.size).toBe(3072);
        });

        it('should generate filename for document without attributes', () => {
            const media = {
                document: {
                    size: 4096
                }
            };

            const result = getMediaInfo(media);
            expect(result.name).toMatch(/transfer_\d+_[a-z0-9]+\.bin/);
            expect(result.size).toBe(4096);
        });
    });

    describe('sanitizeHeaders', () => {
        it('should remove blacklisted headers', () => {
            const headers = {
                'content-type': 'application/json',
                'nel': 'no',
                'report-to': 'group',
                'cf-ray': 'abc123',
                'server': 'nginx',
                'date': 'Thu, 01 Jan 2025 00:00:00 GMT'
            };

            const result = sanitizeHeaders(headers);
            expect(result).toEqual({ 'content-type': 'application/json' });
        });

        it('should remove cf-* headers', () => {
            const headers = {
                'content-type': 'application/json',
                'cf-cache-status': 'HIT',
                'cf-visitor': '{"scheme":"https"}'
            };

            const result = sanitizeHeaders(headers);
            expect(result).toEqual({ 'content-type': 'application/json' });
        });

        it('should return empty object for null input', () => {
            expect(sanitizeHeaders(null)).toEqual({});
        });

        it('should return empty object for undefined input', () => {
            expect(sanitizeHeaders(undefined)).toEqual({});
        });

        it('should handle Headers object', () => {
            const headers = new Map([
                ['content-type', 'application/json'],
                ['cf-ray', 'abc123']
            ]);
            
            const result = sanitizeHeaders(headers);
            expect(result).toEqual({ 'content-type': 'application/json' });
        });

        it('should be case-insensitive for blacklist matching', () => {
            const headers = {
                'Content-Type': 'application/json',
                'NEL': 'no',
                'Server': 'nginx'
            };

            const result = sanitizeHeaders(headers);
            expect(result).toEqual({ 'Content-Type': 'application/json' });
        });
    });

    describe('updateStatus', () => {
        it('should call safeEdit with cancel button for non-final status', async () => {
            const task = {
                id: 'task-1',
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
                buttons: [expect.objectContaining({ text: 'cancel_task', data: 'cancel_confirm_task-1' })],
                parseMode: 'markdown'
            });
        });

        it('should call safeEdit with transfer cancel button for processing task', async () => {
            const task = {
                id: 'task-2',
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
                buttons: [expect.objectContaining({ text: 'cancel_transfer', data: 'cancel_confirm_task-2' })],
                parseMode: 'markdown'
            });
        });

        it('should call safeEdit with retry confirmation button for final retryable status', async () => {
            const task = {
                id: 'task-3',
                chatId: 123456,
                msgId: 789,
                userId: 'user123'
            };

            await updateStatus(task, 'Failed!', true, null, true);

            const taskFn = mockRunBotTaskWithRetry.mock.calls[0][0];
            await taskFn();

            expect(mockClient.editMessage).toHaveBeenCalledWith(123456, {
                message: 789,
                text: 'Failed!',
                buttons: [expect.objectContaining({ text: 'retry', data: 'retry_confirm_task-3' })],
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

        it('should send a fallback message when final status edit fails', async () => {
            const task = {
                id: 'task-4',
                chatId: 123456,
                msgId: 789,
                userId: 'user123'
            };
            mockClient.editMessage.mockRejectedValueOnce(new Error('MESSAGE_ID_INVALID'));

            await updateStatus(task, 'Failed!', true, null, true);

            expect(mockClient.editMessage).toHaveBeenCalledWith(123456, {
                message: 789,
                text: 'Failed!',
                buttons: [expect.objectContaining({ text: 'retry', data: 'retry_confirm_task-4' })],
                parseMode: 'markdown'
            });
            expect(mockClient.sendMessage).toHaveBeenCalledWith(123456, {
                message: 'Failed!',
                buttons: [expect.objectContaining({ text: 'retry', data: 'retry_confirm_task-4' })],
                parseMode: 'markdown'
            });
        });

        it('should not send a fallback message when non-final status edit fails', async () => {
            const task = {
                id: 'task-5',
                chatId: 123456,
                msgId: 789,
                userId: 'user123'
            };
            mockClient.editMessage.mockRejectedValueOnce(new Error('MESSAGE_ID_INVALID'));

            await updateStatus(task, 'Downloading...', false);

            expect(mockClient.sendMessage).not.toHaveBeenCalled();
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
