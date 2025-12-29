// Mock for @upstash/qstash
export const mockVerify = jest.fn();

export class Receiver {
  constructor(options) {
    this.currentSigningKey = options.currentSigningKey;
    this.nextSigningKey = options.nextSigningKey;
  }
  
  async verify(options) {
    return mockVerify(options);
  }
}