// __tests__/mocks/qstash.js
export const Client = function() {
  return {
    publish: () => Promise.resolve({ messageId: 'mock-id' })
  };
};
export const Receiver = function() {};