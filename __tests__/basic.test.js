describe('Basic Compliance', () => {
    test('should pass simple arithmetic test', () => {
        const result = 2 + 2;
        expect(result).toBe(4);
    });

    test('should handle synchronous operation', () => {
        const arr = [1, 2, 3];
        const sum = arr.reduce((a, b) => a + b, 0);
        expect(sum).toBe(6);
    });

    test('should handle async operation', async () => {
        const result = await Promise.resolve(42);
        expect(result).toBe(42);
    });

    test('should verify boolean logic', () => {
        expect(true).toBe(true);
        expect(false).toBe(false);
        expect(!true).toBe(false);
        expect(!false).toBe(true);
    });

    test('should handle string operations', () => {
        const str = 'hello';
        expect(str + ' world').toBe('hello world');
        expect(str.includes('hell')).toBe(true);
    });
});