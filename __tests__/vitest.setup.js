import { vi, describe, test, expect, beforeEach, afterEach, beforeAll, afterAll, jest } from 'vitest';

vi.useFakeTimers();

global.fetch = vi.fn();

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'debug').mockImplementation(() => {});
vi.spyOn(console, 'info').mockImplementation(() => {});
