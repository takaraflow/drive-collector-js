import { vi, describe, it, expect, beforeEach } from 'vitest';

// Mock dependencies
const mockClient = {
    getMessages: vi.fn()
};
vi.mock('../../src/services/telegram.js', () => ({
    client: mockClient
}));

const mockRunMtprotoTask = vi.fn();
vi.mock('../../src/utils/limiter.js', () => ({
    runMtprotoTask: mockRunMtprotoTask
}));

const { LinkParser } = await import('../../src/core/LinkParser.js');

describe('LinkParser', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRunMtprotoTask.mockImplementation(async (fn) => fn());
    });

    describe('parse', () => {
        it('should return null for invalid telegram link', async () => {
            const result = await LinkParser.parse('https://example.com');
            expect(result).toBeNull();
        });

        it('should return null for non-telegram link', async () => {
            const result = await LinkParser.parse('not a link');
            expect(result).toBeNull();
        });

        it('should return null when getMessages returns empty result', async () => {
            mockClient.getMessages.mockResolvedValue([]);

            const result = await LinkParser.parse('https://t.me/channel/123');
            expect(result).toBeNull();
            expect(mockClient.getMessages).toHaveBeenCalledWith('channel', { ids: expect.any(Array) });
        });

        it('should return null when target message not found', async () => {
            mockClient.getMessages.mockResolvedValue([
                { id: 120, media: true },
                { id: 124, media: true }
            ]);

            const result = await LinkParser.parse('https://t.me/channel/123');
            expect(result).toBeNull();
        });

        it('should return single media message when not grouped', async () => {
            const targetMsg = { id: 123, media: { document: { attributes: [{ fileName: 'test.mp4' }] } } };
            mockClient.getMessages.mockResolvedValue([targetMsg]);

            const result = await LinkParser.parse('https://t.me/channel/123');
            expect(result).toEqual([targetMsg]);
        });

        it('should return media group messages when groupedId exists', async () => {
            const messages = [
                { id: 120, media: true, groupedId: 'group1' },
                { id: 121, media: false, groupedId: 'group1' },
                { id: 122, media: true, groupedId: 'group1' },
                { id: 123, media: true, groupedId: 'group1' },
                { id: 124, media: true, groupedId: 'group2' }
            ];
            mockClient.getMessages.mockResolvedValue(messages);

            const result = await LinkParser.parse('https://t.me/channel/123');
            expect(result).toEqual([
                { id: 120, media: true, groupedId: 'group1' },
                { id: 122, media: true, groupedId: 'group1' },
                { id: 123, media: true, groupedId: 'group1' }
            ]);
        });

        it('should handle groupedId as BigInt', async () => {
            const messages = [
                { id: 123, media: true, groupedId: 12345678901234567890n }
            ];
            mockClient.getMessages.mockResolvedValue(messages);

            const result = await LinkParser.parse('https://t.me/channel/123');
            expect(result).toEqual([messages[0]]);
        });

        it('should throw error on client.getMessages failure', async () => {
            mockClient.getMessages.mockRejectedValue(new Error('API Error'));

            await expect(LinkParser.parse('https://t.me/channel/123'))
                .rejects.toThrow('链接解析失败: API Error');
        });

        it('should call runMtprotoTask with correct parameters', async () => {
            mockRunMtprotoTask.mockImplementation(async (task) => {
                return task();
            });
            mockClient.getMessages.mockResolvedValue([]);

            await LinkParser.parse('https://t.me/channel/123');
            expect(mockRunMtprotoTask).toHaveBeenCalledTimes(1);
        });
    });
});