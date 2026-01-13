import { vi, describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, jest } from 'vitest';

const baseEnv = { NODE_ENV: 'test' };

const resetEnv = () => {
  if (typeof process !== 'undefined' && process.env) {
    process.env = { ...baseEnv };
  }
};

vi.useFakeTimers();
vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

global.fetch = vi.fn();

const silenceOutput = () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});

  if (process.stdout && typeof process.stdout.write === 'function') {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  }
  if (process.stderr && typeof process.stderr.write === 'function') {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  }
};

resetEnv();
silenceOutput();

beforeEach(() => {
  resetEnv();
  silenceOutput();
});
