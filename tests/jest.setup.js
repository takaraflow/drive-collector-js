import { jest } from '@jest/globals';

// 全局启用现代 fake timers，避免真实定时器导致 open handles
jest.useFakeTimers('modern');

// 全局 mock fetch，避免真实网络 IO
global.fetch = jest.fn();

// 全局 mock console（可选，根据需求）
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});
jest.spyOn(console, 'debug').mockImplementation(() => {});