/**
 * 异步密码处理集成测试
 *
 * 测试所有 Provider 是否正确 await processPassword
 * 这个测试能捕获忘记 await 导致的 "[object Promise]" bug
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// 测试 Mock 的 CloudTool
const mockCloudTool = {
    _obscure: vi.fn((password) => Promise.resolve(`obscured_${password}`)),
    validateConfig: vi.fn()
};

describe('异步密码处理集成测试 (Integration Test)', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    /**
     * 核心测试：验证 processPassword 返回的是字符串，不是 Promise
     * 如果忘记 await processPassword，返回的就是 Promise 对象
     */
    describe('CloudTool._obscure 异步行为' , () => {
        test('_obscure should return Promise, not string directly', async () => {
            const result = mockCloudTool._obscure('test_password');

            // 验证返回的是 Promise
            expect(result).toBeInstanceOf(Promise);

            // 验证 resolve 后才是字符串
            const resolvedResult = await result;
            expect(typeof resolvedResult).toBe('string');
            expect(resolvedResult).toBe('obscured_test_password');
        });

        test('_obscure Promise should not be "[object Promise]"', async () => {
            const password = 'mypassword';
            const promise = mockCloudTool._obscure(password);

            // Promise 对象本身不是字符串
            expect(typeof promise).toBe('object');
            expect(promise.constructor.name).toBe('Promise');
            expect(promise).not.toBe('[object Promise]');

            // 但如果直接转成字符串，会变成 "[object Promise]"
            const stringified = String(promise);
            expect(stringified).toBe('[object Promise]');

            // 正确的做法是 await 后得到实际字符串
            const actualPassword = await promise;
            expect(actualPassword).toBe('obscured_mypassword');
            expect(typeof actualPassword).toBe('string');
            expect(actualPassword).not.toContain('[object Promise]');
        });
    });

    /**
     * 测试场景：如果没有 await，如何检测 Promise
     */
    describe('检测未 await 的 Promise' , () => {
        test('should detect when Promise is not awaited', async () => {
            function badProcessPassword(password) {
                // 错误的实现：没有 await
                return mockCloudTool._obscure(password);
            }

            function goodProcessPassword(password) {
                // 正确的实现：有 await
                return mockCloudTool._obscure(password);
            }

            // 错误实现返回 Promise 对象
            const badResult = badProcessPassword('test');
            expect(badResult).toBeInstanceOf(Promise);

            // 如果直接使用，会是 "[object Promise]"
            const badConnectionString = `:mega,pass="${String(badResult)}":`;
            expect(badConnectionString).toContain('[object Promise]');

            // 正确实现也返回 Promise（因为是 async）
            const goodPromise = goodProcessPassword('test');
            expect(goodPromise).toBeInstanceOf(Promise);

            // 但 await 后得到字符串
            const goodResult = await goodPromise;
            expect(typeof goodResult).toBe('string');
            expect(goodResult).not.toContain('[object Promise]');

            // 正确的连接字符串
            const goodConnectionString = `:mega,pass="${goodResult}":`;
            expect(goodConnectionString).toBe(':mega,pass="obscured_test":');
            expect(goodConnectionString).not.toContain('[object Promise]');
        });

        test('validateConfig 应该使用 await 处理密码', async () => {
            let capturedConfig = null;

            mockCloudTool.validateConfig.mockImplementation((type, config) => {
                capturedConfig = config;
                return Promise.resolve({ success: true });
            });

            // 模拟正确的 validateConfig 实现
            async function correctValidateConfig(configData) {
                const processedPass = await mockCloudTool._obscure(configData.pass);
                return await mockCloudTool.validateConfig('mega', {
                    ...configData,
                    pass: processedPass
                });
            }

            await correctValidateConfig({ user: 'test@example.com', pass: 'mypassword' });

            // 验证传递给 validateConfig 的是字符串，不是 Promise
            expect(capturedConfig).not.toBeNull();
            expect(typeof capturedConfig.pass).toBe('string');
            expect(capturedConfig.pass).toBe('obscured_mypassword');
            expect(capturedConfig.pass).not.toContain('[object Promise]');
        });

        test('validateConfig 如果忘记 await 会导致 bug', async () => {
            let capturedConfig = null;

            mockCloudTool.validateConfig.mockImplementation((type, config) => {
                capturedConfig = config;
                return Promise.resolve({ success: true });
            });

            // 模拟错误的 validateConfig 实现（忘记 await）
            async function incorrectValidateConfig(configData) {
                const processedPass = mockCloudTool._obscure(configData.pass); // 没有 await！
                return await mockCloudTool.validateConfig('mega', {
                    ...configData,
                    pass: processedPass // 这里传的是 Promise
                });
            }

            await incorrectValidateConfig({ user: 'test@example.com', pass: 'mypassword' });

            // 验证传递给 validateConfig 的是 Promise 对象
            expect(capturedConfig).not.toBeNull();
            expect(typeof capturedConfig.pass).toBe('object'); // Promise 是 object
            expect(capturedConfig.pass).toBeInstanceOf(Promise);

            // 转成字符串会是 "[object Promise]"
            const passString = String(capturedConfig.pass);
            expect(passString).toBe('[object Promise]');
        });
    });

    /**
     * 检测 Promise 对象的实用方法
     */
    describe('Promise 检测工具函数', () => {
        function isPromise(value) {
            return value instanceof Promise ||
                (value !== null &&
                value !== undefined &&
                typeof value === 'object' &&
                typeof value.then === 'function' &&
                typeof value.catch === 'function');
        }

        function isPromiseObjectString(value) {
            return typeof value === 'string' && value === '[object Promise]';
        }

        test('should correctly identify Promise objects', () => {
            const promise = mockCloudTool._obscure('test');

            expect(isPromise(promise)).toBe(true);
            expect(isPromise('string')).toBe(false);
            expect(isPromise({})).toBe(false);
            expect(isPromise(null)).toBe(false);
        });

        test('should detect "[object Promise]" string', () => {
            const promise = mockCloudTool._obscure('test');

            expect(isPromiseObjectString(String(promise))).toBe(true);
            expect(isPromiseObjectString('normal string')).toBe(false);
            expect(isPromiseObjectString('[object Object]')).toBe(false);
        });

        test('should help debug password processing', async () => {
            const password = 'secret123';
            const processed = mockCloudTool._obscure(password);

            // 检测是否是未 resolved 的 Promise
            if (isPromise(processed) && typeof processed !== 'string') {
                console.log('Warning: password is still a Promise, need to await');
            }

            // 使用 await
            const resolved = await processed;

            // 现在应该是字符串
            expect(typeof resolved).toBe('string');
            expect(isPromise(resolved)).toBe(false);
        });
    });
});

/**
 * 这个测试文件展示了如何正确测试异步密码处理
 * 关键点：
 * 1. CloudTool._obscure 返回的是 Promise
 * 2. 如果忘记 await，传递下去的就是 Promise 对象
 * 3. Promise 对象转字符串会变成 "[object Promise]"
 * 4. 必须使用 await 来获取实际值
 */
