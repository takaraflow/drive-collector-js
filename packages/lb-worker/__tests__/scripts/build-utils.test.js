import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';

const originalEnv = { ...process.env };

// Import actual functions
import { loadEnvFile, hasInfisicalCredentials } from '../../scripts/build-utils.js';

describe('build-utils.js - hasInfisicalCredentials', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset process.env
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        // Restore process.env
        process.env = { ...originalEnv };
        vi.restoreAllMocks();
    });

    test('returns true when Infisical project data exists', () => {
        process.env.INFISICAL_PROJECT_ID = 'proj-id';
        process.env.INFISICAL_TOKEN = 'token';
        
        const projectId = (process.env.INFISICAL_PROJECT_ID || '').trim();
        const token = (process.env.INFISICAL_TOKEN || '').trim();
        expect(hasInfisicalCredentials(process.env)).toBe(true);
    });

    test('returns true when INFISICAL_ENV_INJECTED is set', () => {
        process.env.INFISICAL_ENV_INJECTED = 'true';
        expect(hasInfisicalCredentials(process.env)).toBe(true);
    });

    test('returns false when only token exists without project id', () => {
        delete process.env.INFISICAL_PROJECT_ID;
        process.env.INFISICAL_TOKEN = 'token';
        expect(hasInfisicalCredentials()).toBe(false);
    });

    test('returns false when no Infisical markers are present', () => {
        delete process.env.INFISICAL_PROJECT_ID;
        delete process.env.INFISICAL_TOKEN;
        delete process.env.INFISICAL_ENV_INJECTED;
        expect(hasInfisicalCredentials()).toBe(false);
    });
});

    describe('build-utils.js - loadEnvFile (Integration Tests)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset process.env
        process.env = { ...originalEnv };
        
        // Mock path.join to return predictable paths
        vi.spyOn(path, 'join').mockImplementation((...args) => {
            const lastArg = args[args.length - 1];
            // Handle any path that ends with .env*
            if (typeof lastArg === 'string' && lastArg.includes('.env')) {
                return `/test/project/${lastArg}`;
            }
            return args.join('/');
        });
    });

    afterEach(() => {
        // Restore process.env
        process.env = { ...originalEnv };
        vi.restoreAllMocks();
    });

    test('should not throw when no .env files exist', () => {
        // Mock fs object
        const mockFs = {
            existsSync: vi.fn(() => false),
            readFileSync: vi.fn(),
        };

        expect(() => loadEnvFile(mockFs, 'dev')).not.toThrow();
    });

    test('should handle empty .env file', () => {
        const mockFs = {
            existsSync: vi.fn(() => true),
            readFileSync: vi.fn(() => ''),
        };

        expect(() => loadEnvFile(mockFs, 'dev')).not.toThrow();
    });

    test('should handle comments only in .env file', () => {
        const mockFs = {
            existsSync: vi.fn(() => true),
            readFileSync: vi.fn(() => '# Comment\n\n# Another comment\n'),
        };

        expect(() => loadEnvFile(mockFs, 'dev')).not.toThrow();
    });

    test('should set simple key=value pairs', () => {
        const mockFs = {
            existsSync: vi.fn(() => true),
            readFileSync: vi.fn(() => 'VAR1=value1\nVAR2=value2'),
        };

        delete process.env.VAR1;
        delete process.env.VAR2;

        // Pass overrideExisting: true to ensure env vars are set
        loadEnvFile(mockFs, 'dev', { overrideExisting: true });

        expect(process.env.VAR1).toBe('value1');
        expect(process.env.VAR2).toBe('value2');
    });

    test('should handle quoted values', () => {
        const mockFs = {
            existsSync: vi.fn(() => true),
            readFileSync: vi.fn(() => 'VAR1="double quoted"\nVAR2=\'single quoted\''),
        };

        delete process.env.VAR1;
        delete process.env.VAR2;

        loadEnvFile(mockFs, 'dev', { overrideExisting: true });

        expect(process.env.VAR1).toBe('double quoted');
        expect(process.env.VAR2).toBe('single quoted');
    });

    test('should handle inline comments', () => {
        const mockFs = {
            existsSync: vi.fn(() => true),
            readFileSync: vi.fn(() => 'VAR1=value1 # comment\nVAR2=value2#comment'),
        };

        delete process.env.VAR1;
        delete process.env.VAR2;

        loadEnvFile(mockFs, 'dev', { overrideExisting: true });

        expect(process.env.VAR1).toBe('value1');
        expect(process.env.VAR2).toBe('value2');
    });

    test('should handle empty lines', () => {
        const mockFs = {
            existsSync: vi.fn(() => true),
            readFileSync: vi.fn(() => '\nVAR1=value1\n\nVAR2=value2\n  \n'),
        };

        delete process.env.VAR1;
        delete process.env.VAR2;

        loadEnvFile(mockFs, 'dev', { overrideExisting: true });

        expect(process.env.VAR1).toBe('value1');
        expect(process.env.VAR2).toBe('value2');
    });

    test('should preserve existing env vars by default', () => {
        const mockFs = {
            existsSync: vi.fn(() => true),
            readFileSync: vi.fn(() => 'EXISTING_VAR=new_value'),
        };

        process.env.EXISTING_VAR = 'original_value';

        loadEnvFile(mockFs, 'dev');

        expect(process.env.EXISTING_VAR).toBe('original_value');
    });

    test('should override existing env vars when overrideExisting is true', () => {
        const mockFs = {
            existsSync: vi.fn(() => true),
            readFileSync: vi.fn(() => 'EXISTING_VAR=override_value'),
        };

        process.env.EXISTING_VAR = 'original_value';

        loadEnvFile(mockFs, 'dev', { overrideExisting: true });

        expect(process.env.EXISTING_VAR).toBe('override_value');
    });
});
