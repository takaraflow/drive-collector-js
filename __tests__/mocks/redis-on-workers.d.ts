type RedisCommand = string | number;
type RedisResult = Promise<any>;

export function createRedis(options?: Record<string, any>): {
  send: (command: RedisCommand, ...args: any[]) => RedisResult;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  options: Record<string, any>;
  isConnected: boolean;
};

export const __mockSend: (...args: any[]) => RedisResult;
export const __mockData: Map<string, any>;

export function resetMockData(): void;
export function setMockValue(key: string, value: any): void;
export function getMockValue(key: string): any;
export function deleteMockValue(key: string): void;
