import { jest } from '@jest/globals';

const mockSend = jest.fn();

// Helper to inject errors for specific call indices
// Usage: __mockSend.mockImplementationOnce(__mockSend.injectError(new Error('ECONNRESET'), 0));
// This will make the 1st call (index 0) throw an error
mockSend.injectError = (error, callIndex = 0) => {
  return (...args) => {
    const currentCallCount = mockSend.mock.calls.length;
    if (currentCallCount === callIndex) {
      throw error;
    }
    // Return a default value or let it be controlled by other mocks
    // For simplicity in tests, we usually chain mockResolvedValue/mockRejectedValue
    // This helper is for specific "flaky" behavior simulation
    return 'OK';
  };
};

export function createRedis(options) {
  return {
    send: mockSend,
    connect: jest.fn(),
    options,
  };
}

export const __mockSend = mockSend;

// Important: Ensure mockSend is reset before each test in the test files
// or use beforeEach in this mock file if possible (not recommended for simple mocks)
