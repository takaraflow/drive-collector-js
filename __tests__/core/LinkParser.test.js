import { LinkParser } from '../src/core/LinkParser';

// Mock external dependencies
jest.mock('../src/services/telegram.js', () => ({
  client: {
    getMessages: jest.fn(),
  },
}));

jest.mock('../src/utils/limiter.js', () => ({
  runMtprotoTask: jest.fn((fn) => fn()),
}));

describe('LinkParser', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('parse', () => {
    test('returns null for invalid URL format', async () => {
      const result = await LinkParser.parse('invalid url');
      expect(result).toBeNull();
    });

    test('returns null for non-telegram URLs', async () => {
      const result = await LinkParser.parse('https://google.com');
      expect(result).toBeNull();
    });

    test('parses valid Telegram message URL', async () => {
      const mockClient = require('../src/services/telegram.js').client;
      const mockMessage = {
        id: 123,
        media: { document: { attributes: [{ fileName: 'test.mp4' }], size: 1000 } }
      };
      mockClient.getMessages.mockResolvedValue([mockMessage]);

      const result = await LinkParser.parse('https://t.me/channel/123');

      expect(mockClient.getMessages).toHaveBeenCalledWith('channel', { ids: expect.any(Array) });
      expect(result).toEqual([mockMessage]);
    });

    test('handles media groups correctly', async () => {
      const mockClient = require('../src/services/telegram.js').client;
      const messages = [
        { id: 120, groupedId: 'group1', media: true },
        { id: 121, groupedId: 'group1', media: true },
        { id: 122, groupedId: 'group1', media: true },
        { id: 123, groupedId: 'group1', media: true },
      ];
      mockClient.getMessages.mockResolvedValue(messages);

      const result = await LinkParser.parse('https://t.me/channel/123');

      expect(result).toHaveLength(4);
      expect(result.every(msg => msg.groupedId === 'group1')).toBe(true);
    });

    test('returns single message when no media group', async () => {
      const mockClient = require('../src/services/telegram.js').client;
      const mockMessage = {
        id: 123,
        media: { document: { attributes: [{ fileName: 'test.mp4' }], size: 1000 } }
      };
      mockClient.getMessages.mockResolvedValue([mockMessage]);

      const result = await LinkParser.parse('https://t.me/channel/123');

      expect(result).toEqual([mockMessage]);
    });

    test('throws error on client failure', async () => {
      const mockClient = require('../src/services/telegram.js').client;
      mockClient.getMessages.mockRejectedValue(new Error('Network error'));

      await expect(LinkParser.parse('https://t.me/channel/123'))
        .rejects.toThrow('链接解析失败: Network error');
    });

    test('returns null when target message not found', async () => {
      const mockClient = require('../src/services/telegram.js').client;
      mockClient.getMessages.mockResolvedValue([{ id: 120 }, { id: 121 }]); // no message with id 123

      const result = await LinkParser.parse('https://t.me/channel/123');

      expect(result).toBeNull();
    });

    test('filters out invalid messages', async () => {
      const mockClient = require('../src/services/telegram.js').client;
      const messages = [
        null,
        undefined,
        { id: 123, media: { document: { attributes: [{ fileName: 'test.mp4' }], size: 1000 } } },
        'invalid'
      ];
      mockClient.getMessages.mockResolvedValue(messages);

      const result = await LinkParser.parse('https://t.me/channel/123');

      expect(result).toEqual([messages[2]]);
    });
  });
});