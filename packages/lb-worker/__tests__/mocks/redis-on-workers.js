import { vi } from 'vitest';

const mockData = new Map();
const mockSend = vi.fn();

mockSend.mockImplementation((command, ...args) => {
  const cmd = command.toUpperCase();

  switch (cmd) {
    case 'GET':
      const getKey = args[0];
      const value = mockData.get(getKey);
      return Promise.resolve(value || null);

    case 'SET':
      const setKey = args[0];
      const setValue = args[1];
      mockData.set(setKey, setValue);
      return Promise.resolve('OK');

    case 'DEL':
      const delKey = args[0];
      const existed = mockData.has(delKey);
      mockData.delete(delKey);
      return Promise.resolve(existed ? 1 : 0);

    case 'KEYS':
      const pattern = args[0] || '*';
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      const keys = Array.from(mockData.keys()).filter(k => regex.test(k));
      return Promise.resolve(keys);

    case 'SCAN':
      const cursor = args[0];
      const scanPattern = args[1]?.match || '*';
      const scanRegex = new RegExp('^' + scanPattern.replace(/\*/g, '.*') + '$');
      const matchingKeys = Array.from(mockData.keys()).filter(k => scanRegex.test(k));
      return Promise.resolve({ cursor: 0, keys: matchingKeys });

    case 'PING':
      return Promise.resolve('PONG');

    case 'EXISTS':
      const existsKey = args[0];
      return Promise.resolve(mockData.has(existsKey) ? 1 : 0);

    case 'EXPIRE':
      return Promise.resolve(1);

    case 'TTL':
      return Promise.resolve(-1);

    default:
      return Promise.resolve('OK');
  }
});

mockSend.injectError = (error, callIndex = 0) => {
  return (...args) => {
    const currentCallCount = mockSend.mock.calls.length;
    if (currentCallCount === callIndex) {
      throw error;
    }
    return mockSend(...args);
  };
};

export function createRedis(options = {}) {
  return {
    send: mockSend,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    options,
    isConnected: true,
  };
}

export const __mockSend = mockSend;
export const __mockData = mockData;

export function resetMockData() {
  mockData.clear();
  mockSend.mockClear();
}

export function setMockValue(key, value) {
  mockData.set(key, value);
}

export function getMockValue(key) {
  return mockData.get(key);
}

export function deleteMockValue(key) {
  mockData.delete(key);
}
