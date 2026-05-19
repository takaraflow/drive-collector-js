const { 
    limitFields, 
    serializeError, 
    serializeErrorLike,
    pruneData, 
    serializeToString,
    isSensitiveKey,
    redactSensitiveText,
    redactSensitiveData
} = await import('../../../src/utils/serializer.js');

describe('Serializer Utils', () => {
    
    describe('limitFields', () => {
        test('should return original object if not object', () => {
            expect(limitFields(null)).toBeNull();
            expect(limitFields(undefined)).toBeUndefined();
            expect(limitFields('string')).toBe('string');
            expect(limitFields(123)).toBe(123);
            expect(limitFields(true)).toBe(true);
        });

        test('should limit number of fields', () => {
            const obj = { a: 1, b: 2, c: 3, d: 4 };
            const result = limitFields(obj, 2);
            
            expect(result).toEqual({ a: 1, b: 2, _truncated: true });
        });

        test('should use default maxFields of 200', () => {
            const obj = {};
            for (let i = 0; i < 250; i++) {
                obj[`field${i}`] = i;
            }
            
            const result = limitFields(obj);
            const keys = Object.keys(result);
            
            expect(keys).toHaveLength(201); // 200 + _truncated
            expect(result._truncated).toBe(true);
        });

        test('should not truncate if within limit', () => {
            const obj = { a: 1, b: 2, c: 3 };
            const result = limitFields(obj, 5);
            
            expect(result).toEqual({ a: 1, b: 2, c: 3 });
            expect(result._truncated).toBeUndefined();
        });
    });

    describe('serializeError', () => {
        test('should return non-error object as-is', () => {
            const obj = { message: 'not an error' };
            expect(serializeError(obj)).toBe(obj);
        });

        test('should serialize basic Error properties', () => {
            const error = new Error('test error');
            error.stack = 'stack trace';
            
            const result = serializeError(error);
            
            expect(result).toEqual({
                name: 'Error',
                message: 'test error',
                stack: 'stack trace'
            });
        });

        test('should include additional enumerable properties', () => {
            const error = new Error('test error');
            error.code = 'ERR_CODE';
            error.status = 500;
            error.apiKey = 'secret-key';
            error.pass = 'plain-pass';
            
            const result = serializeError(error);
            
            expect(result).toMatchObject({
                name: 'Error',
                message: 'test error',
                code: 'ERR_CODE',
                status: 500,
                apiKey: '[REDACTED]',
                pass: '[REDACTED]'
            });
        });

        test('should redact sensitive values embedded in Error message and stack', () => {
            const error = new Error('failed :mega,user="user@example.com",pass="secret-pass":');
            error.stack = 'Error: token={"access_token":"access-secret","refresh_token":"refresh-secret"}';

            const result = serializeError(error);

            expect(result.message).toContain('pass="[REDACTED]"');
            expect(result.stack).toContain('token=[REDACTED]');
            expect(JSON.stringify(result)).not.toContain('secret-pass');
            expect(JSON.stringify(result)).not.toContain('access-secret');
            expect(JSON.stringify(result)).not.toContain('refresh-secret');
        });

        test('should handle custom error types', () => {
            class CustomError extends Error {
                constructor(message, customField) {
                    super(message);
                    this.name = 'CustomError';
                    this.customField = customField;
                }
            }
            
            const error = new CustomError('custom error', 'custom value');
            const result = serializeError(error);
            
            expect(result).toMatchObject({
                name: 'CustomError',
                message: 'custom error',
                customField: 'custom value'
            });
        });
    });

    describe('serializeErrorLike', () => {
        test('should preserve Error diagnostics', () => {
            const error = new Error('database failed');
            error.stack = 'Error: database failed\n    at test';
            error.code = 'DB_DOWN';

            const result = serializeErrorLike(error);

            expect(result).toMatchObject({
                name: 'Error',
                message: 'database failed',
                stack: 'Error: database failed\n    at test',
                code: 'DB_DOWN',
                type: 'error',
                constructorName: 'Error'
            });
        });

        test('should make primitive promise rejections diagnosable', () => {
            const result = serializeErrorLike('worker rejected');

            expect(result).toEqual({
                name: 'StringRejection',
                message: 'worker rejected',
                type: 'string',
                value: 'worker rejected'
            });
        });

        test('should redact sensitive values in primitive promise rejections', () => {
            const result = serializeErrorLike('remote failed pass="secret" access_token=abc123');

            expect(result.message).toBe('remote failed pass="[REDACTED]" access_token=[REDACTED]');
            expect(result.value).toBe('remote failed pass="[REDACTED]" access_token=[REDACTED]');
            expect(JSON.stringify(result)).not.toContain('secret');
            expect(JSON.stringify(result)).not.toContain('abc123');
        });

        test('should make empty promise rejections diagnosable', () => {
            expect(serializeErrorLike(undefined)).toMatchObject({
                name: 'UndefinedRejection',
                message: 'Promise rejected without a reason',
                type: 'undefined'
            });
            expect(serializeErrorLike(null)).toMatchObject({
                name: 'NullRejection',
                message: 'Promise rejected with null',
                type: 'null'
            });
        });

        test('should preserve safe plain-object rejection fields', () => {
            const result = serializeErrorLike({
                name: 'LibraryRejection',
                message: 'background worker failed',
                code: 'WORKER_FAILED',
                token: 'secret',
                nested: { status: 'bad' }
            });

            expect(result).toMatchObject({
                name: 'LibraryRejection',
                message: 'background worker failed',
                code: 'WORKER_FAILED',
                type: 'object',
                constructorName: 'Object'
            });
            expect(result.properties.token).toBe('[REDACTED]');
            expect(result.properties.nested).toEqual({ status: 'bad' });
        });
    });

    describe('redaction helpers', () => {
        test('should redact rclone remote strings without removing diagnostic context', () => {
            const input = `CRITICAL: Failed for ":mega,user="user@example.com",pass="secret-pass":folder/file": couldn't login`;
            const result = redactSensitiveText(input);

            expect(result).toContain(':mega,user="[REDACTED]",pass="[REDACTED]":folder/file');
            expect(result).toContain("couldn't login");
            expect(result).not.toContain('user@example.com');
            expect(result).not.toContain('secret-pass');
        });

        test('should redact JSON tokens and bearer headers embedded in strings', () => {
            const input = 'token={"access_token":"access-secret","refresh_token":"refresh-secret","client_secret":"client-secret"} Authorization: Bearer bearer-secret';
            const result = redactSensitiveText(input);

            expect(result).toContain('token=[REDACTED]');
            expect(result).toContain('Authorization: Bearer [REDACTED]');
            expect(result).not.toContain('access-secret');
            expect(result).not.toContain('refresh-secret');
            expect(result).not.toContain('client-secret');
            expect(result).not.toContain('bearer-secret');
        });

        test('should redact sensitive strings deeply in objects', () => {
            const result = redactSensitiveData({
                message: 'failed pass="secret"',
                nested: {
                    token: 'plain-token',
                    publicValue: 'visible'
                }
            });

            expect(result.message).toBe('failed pass="[REDACTED]"');
            expect(result.nested).toEqual({
                token: '[REDACTED]',
                publicValue: 'visible'
            });
        });
    });

    describe('pruneData', () => {
        test('should return primitive values unchanged', () => {
            expect(pruneData(null)).toBeNull();
            expect(pruneData(undefined)).toBeUndefined();
            expect(pruneData('string')).toBe('string');
            expect(pruneData(123)).toBe(123);
            expect(pruneData(true)).toBe(true);
        });

        test('should truncate at max depth', () => {
            const deep = {
                level1: {
                    level2: {
                        level3: 'deep value'
                    }
                }
            };
            
            const result = pruneData(deep, 2);
            expect(result.level1.level2).toBe('[Truncated: Max Depth]');
        });

        test('should limit array length', () => {
            const arr = Array.from({ length: 10 }, (_, i) => i);
            const result = pruneData(arr, 3, 5);
            
            expect(result).toHaveLength(6); // 5 items + truncated message
            expect(result[5]).toBe('[Truncated: 5 items]');
        });

        test('should handle circular references', () => {
            const obj = { a: 1 };
            obj.self = obj;
            
            const result = pruneData(obj);
            expect(result.self).toBe('[Circular Reference]');
        });

        test('should limit object keys', () => {
            const obj = {};
            for (let i = 0; i < 10; i++) {
                obj[`key${i}`] = i;
            }
            
            const result = pruneData(obj, 3, 5);
            const keys = Object.keys(result);
            
            expect(keys).toHaveLength(6); // 5 keys + _truncated
            expect(result._truncated).toBe('... 5 more keys');
        });

        test('should serialize Error objects', () => {
            const error = new Error('test error');
            error.code = 'ERR_CODE';
            
            const obj = { error };
            const result = pruneData(obj, 2, 5);
            
            expect(result.error).toMatchObject({
                name: 'Error',
                message: 'test error',
                code: 'ERR_CODE'
            });
        });

        test('should handle empty arrays', () => {
            const arr = [];
            const result = pruneData(arr);
            expect(result).toEqual([]);
        });

        test('should handle empty objects', () => {
            const obj = {};
            const result = pruneData(obj);
            expect(result).toEqual({});
        });
    });

    describe('serializeToString', () => {
        test('should handle special primitive values', () => {
            expect(serializeToString(undefined)).toBe('{"value":"undefined"}');
            expect(serializeToString(() => {})).toBe('{"value":"[Function]"}');
            expect(serializeToString(Symbol('test'))).toBe('{"value":"Symbol(test)"}');
        });

        test('should serialize simple objects', () => {
            const obj = { name: 'test', value: 123 };
            const result = serializeToString(obj);
            
            const parsed = JSON.parse(result);
            expect(parsed).toEqual({ name: 'test', value: 123 });
        });

        test('should redact sensitive fields by key during serialization', () => {
            const obj = {
                token: 'plain-token',
                password: 'plain-password',
                apiKey: 'plain-key',
                authHeader: 'Bearer secret',
                publicValue: 'visible'
            };

            const result = serializeToString(obj, 4, 5000);
            const parsed = JSON.parse(result);

            expect(parsed).toMatchObject({
                token: '[REDACTED]',
                password: '[REDACTED]',
                apiKey: '[REDACTED]',
                authHeader: '[REDACTED]',
                publicValue: 'visible'
            });
            expect(result).not.toContain('plain-token');
            expect(result).not.toContain('plain-password');
            expect(result).not.toContain('plain-key');
            expect(result).not.toContain('Bearer secret');
        });

        test('should redact nested and config_data fields by key', () => {
            const result = serializeToString({
                config_data: { user: 'u', pass: 'p' },
                nested: {
                    workerSecret: 'plain-secret',
                    publicValue: 'visible'
                }
            }, 4, 5000);
            const parsed = JSON.parse(result);

            expect(parsed.config_data).toBe('[REDACTED]');
            expect(parsed.nested).toEqual({
                workerSecret: '[REDACTED]',
                publicValue: 'visible'
            });
            expect(result).not.toContain('plain-secret');
            expect(result).not.toContain('"pass":"p"');
        });

        test('should redact sensitive values embedded in non-sensitive string fields', () => {
            const result = serializeToString({
                stderr: 'Failed to create file system for ":mega,user="u@example.com",pass="secret":root"',
                url: 'https://example.com/callback?access_token=access-secret&safe=1'
            }, 4, 5000);

            expect(result).toContain('pass=\\"[REDACTED]\\"');
            expect(result).toContain('access_token=[REDACTED]');
            expect(result).not.toContain('u@example.com');
            expect(result).not.toContain('secret');
            expect(result).not.toContain('access-secret');
        });

        test('should detect sensitive keys', () => {
            expect(isSensitiveKey('BOT_TOKEN')).toBe(true);
            expect(isSensitiveKey('config_data')).toBe(true);
            expect(isSensitiveKey('x-instance-secret')).toBe(true);
            expect(isSensitiveKey('publicUrl')).toBe(false);
        });

        test('should handle BigInt', () => {
            const obj = { big: BigInt(123) };
            const result = serializeToString(obj);
            
            // 验证结果包含 "123n" 格式
            expect(result).toContain('"123n"');
            
            // 额外验证：解析后可以正确识别
            const parsed = JSON.parse(result);
            expect(parsed.big).toBe('123n');
        });

        test('should truncate long strings', () => {
            const longString = 'x'.repeat(6000);
            const obj = { data: longString };
            const result = serializeToString(obj, 2, 1000);
            
            const parsed = JSON.parse(result);
            expect(parsed.summary).toBe('Data truncated');
            expect(parsed.original_size).toBeGreaterThan(5000);
            expect(parsed.preview).toContain('xxxx');
        });

        test('should handle prune failures', () => {
            // Create object that might cause prune to fail
            const obj = {};
            Object.defineProperty(obj, 'problem', {
                get() { throw new Error('Access denied'); },
                enumerable: true
            });
            
            const result = serializeToString(obj);
            const parsed = JSON.parse(result);
            
            expect(parsed.error).toBe('[Prune failed]');
            expect(parsed.reason).toBe('Access denied');
        });

        test('should handle stringify failures', () => {
            // Create object with values that can't be stringified
            const obj = { 
                value: {},
                get problematic() { throw new Error('Stringify error'); }
            };
            
            const result = serializeToString(obj);
            const parsed = JSON.parse(result);
            
            expect(parsed.error).toBe('[Prune failed]');
            expect(parsed.reason).toBe('Stringify error');
        });

        test('should use default parameters', () => {
            const obj = { simple: 'data' };
            const result = serializeToString(obj);
            
            expect(JSON.parse(result)).toEqual({ simple: 'data' });
        });

        test('should handle Error in stringify', () => {
            // Simulate prune failure
            const obj = { 
                value: {},
                get problematic() { throw new Error('Stringify error'); }
            };
            
            const result = serializeToString(obj);
            const parsed = JSON.parse(result);
            
            expect(parsed.error).toBe('[Prune failed]');
            expect(parsed.reason).toBe('Stringify error');
        });

        test('should handle circular references in stringify', () => {
            const obj = { a: 1 };
            obj.circular = obj;
            
            const result = serializeToString(obj);
            
            expect(result).toContain('[Circular Reference]');
        });

        test('should include service name in truncated result', () => {
            const obj = { service: 'test-service', data: 'x'.repeat(6000) };
            const result = serializeToString(obj, 2, 1000);
            
            const parsed = JSON.parse(result);
            expect(parsed.service).toBe('test-service');
        });
    });

    describe('Edge Cases', () => {
        test('should handle deeply nested arrays', () => {
            const arr = [[[['deep']]]];
            const result = pruneData(arr, 2);
            
            expect(result[0][0]).toBe('[Truncated: Max Depth]');
        });

        test('should handle mixed circular references', () => {
            const obj1 = { name: 'obj1' };
            const obj2 = { name: 'obj2', ref: obj1 };
            obj1.ref = obj2;
            
            const result = pruneData(obj1, 3, 10, 0, new WeakSet());
            // The ref should be pruned due to depth limit before circular detection
            expect(typeof result.ref).toBe('object');
            expect(result.ref).not.toBe('[Circular Reference]');
        });

        test('should handle sparse arrays', () => {
            const arr = new Array(10);
            arr[0] = 'first';
            arr[9] = 'last';
            
            const result = pruneData(arr, 2, 5);
            
            expect(result[0]).toBe('first');
            expect(result[9]).toBeUndefined();
            expect(result.length).toBeGreaterThan(0);
        });

        test('should handle prototype pollution attempts', () => {
            const obj = JSON.parse('{"__proto__": {"polluted": true}}');
            const result = pruneData(obj);
            
            // Should not pollute Object.prototype
            expect(({}).polluted).toBeUndefined();
        });

        test('should handle date objects', () => {
            const date = new Date('2023-01-01');
            const obj = { date };
            const result = pruneData(obj, 2);
            
            expect(result.date).toBeInstanceOf(Object);
            expect(typeof result.date).toBe('object');
        });

        test('should handle regex objects', () => {
            const regex = /test/g;
            const obj = { pattern: regex };
            const result = pruneData(obj, 2);
            
            expect(result.pattern).toBeInstanceOf(Object);
            expect(typeof result.pattern).toBe('object');
        });
    });
});
