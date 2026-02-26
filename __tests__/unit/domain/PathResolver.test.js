const { resolvePaths, shouldIgnore, matchPattern } = await import('../../../src/domain/PathResolver.js');

describe('PathResolver', () => {
    describe('resolvePaths', () => {
        it('should resolve relative paths to absolute', () => {
            const baseDir = '/home/user/project';
            const inputs = ['./src/index.js', './lib/utils.js'];
            
            const result = resolvePaths(baseDir, inputs);
            
            expect(result).toEqual([
                '/home/user/project/src/index.js',
                '/home/user/project/lib/utils.js'
            ]);
        });

        it('should handle absolute paths unchanged', () => {
            const baseDir = '/home/user/project';
            const inputs = ['/absolute/path/file.js'];
            
            const result = resolvePaths(baseDir, inputs);
            
            expect(result).toEqual(['/absolute/path/file.js']);
        });

        it('should handle paths without ./ prefix', () => {
            const baseDir = '/home/user/project';
            const inputs = ['src/index.js', 'lib/utils.js'];
            
            const result = resolvePaths(baseDir, inputs);
            
            expect(result).toEqual([
                '/home/user/project/src/index.js',
                '/home/user/project/lib/utils.js'
            ]);
        });
    });

    describe('shouldIgnore', () => {
        it('should return true for ignored patterns', () => {
            const ignoreRules = ['*.log', 'node_modules/*', '.git/*'];
            
            expect(shouldIgnore('debug.log', ignoreRules)).toBe(true);
            expect(shouldIgnore('node_modules/package/index.js', ignoreRules)).toBe(true);
            expect(shouldIgnore('.git/config', ignoreRules)).toBe(true);
        });

        it('should return false for non-ignored files', () => {
            const ignoreRules = ['*.log', 'node_modules/*'];
            
            expect(shouldIgnore('src/index.js', ignoreRules)).toBe(false);
            expect(shouldIgnore('README.md', ignoreRules)).toBe(false);
        });
    });

    describe('matchPattern', () => {
        it('should match glob patterns', () => {
            expect(matchPattern('test.js', '*.js')).toBe(true);
            expect(matchPattern('src/test.js', 'src/*.js')).toBe(true);
            expect(matchPattern('test.ts', '*.js')).toBe(false);
        });
    });
});
