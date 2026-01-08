import { jest, describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import path from 'path';

const originalEnv = { ...process.env };

// Mock fs module
jest.unstable_mockModule('fs', () => ({
    default: {
        existsSync: jest.fn(),
        readFileSync: jest.fn(),
    },
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
}));

// Import mocked modules
const fs = await import('fs');
const { loadEnvFile, hasInfisicalCredentials } = await import('../../scripts/build-logic.js');

describe('build-logic.js - loadEnvFile', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset process.env
        process.env = { ...originalEnv };
        
        // Mock path.join to return predictable paths
        jest.spyOn(path, 'join').mockImplementation((...args) => {
            const lastArg = args[args.length - 1];
            if (lastArg === '.env.dev' || lastArg === '.env.prod' || lastArg === '.env') {
                return `/test/project/${lastArg}`;
            }
            return args.join('/');
        });
    });

    afterEach(() => {
        // Restore process.env
        process.env = { ...originalEnv };
        jest.restoreAllMocks();
    });

    test('should_load_env_dev_then_env_when_loading_dev_environment', () => {
        // Mock file system
        fs.existsSync.mockImplementation((path) => {
            return path === '/test/project/.env.dev' || path === '/test/project/.env';
        });

        fs.readFileSync.mockImplementation((path) => {
            if (path === '/test/project/.env.dev') {
                return 'DEV_VAR=dev_value\nSHARED_VAR=dev_shared';
            }
            if (path === '/test/project/.env') {
                return 'SHARED_VAR=base_shared\nBASE_VAR=base_value';
            }
            return '';
        });

        // Clear relevant env vars first
        delete process.env.DEV_VAR;
        delete process.env.SHARED_VAR;
        delete process.env.BASE_VAR;

        loadEnvFile(fs, 'dev');

        // Should load .env.dev first, then .env (but .env shouldn't override existing)
        expect(process.env.DEV_VAR).toBe('dev_value');
        expect(process.env.SHARED_VAR).toBe('dev_shared'); // From .env.dev, not overridden by .env
        expect(process.env.BASE_VAR).toBe('base_value'); // From .env
    });

    test('should_override_base_env_vars_with_prod_env_vars', () => {
        // Mock file system
        fs.existsSync.mockImplementation((path) => {
            return path === '/test/project/.env.prod' || path === '/test/project/.env';
        });

        fs.readFileSync.mockImplementation((path) => {
            if (path === '/test/project/.env.prod') {
                return 'SHARED_VAR=prod_value\nPROD_VAR=prod_only';
            }
            if (path === '/test/project/.env') {
                return 'SHARED_VAR=base_shared\nBASE_VAR=base_value';
            }
            return '';
        });

        // Clear relevant env vars first
        delete process.env.SHARED_VAR;
        delete process.env.PROD_VAR;
        delete process.env.BASE_VAR;

        loadEnvFile(fs, 'prod');

        // .env.prod should override .env for SHARED_VAR
        expect(process.env.SHARED_VAR).toBe('prod_value');
        expect(process.env.PROD_VAR).toBe('prod_only');
        expect(process.env.BASE_VAR).toBe('base_value');
    });

    test('should_preserve_existing_env_vars_except_placeholders', () => {
        // Mock file system
        fs.existsSync.mockImplementation((path) => {
            return path === '/test/project/.env.dev' || path === '/test/project/.env';
        });

        fs.readFileSync.mockImplementation((path) => {
            if (path === '/test/project/.env.dev') {
                return 'EXISTING_VAR=new_value\nPLACEHOLDER_VAR=${PLACEHOLDER_VAR}';
            }
            if (path === '/test/project/.env') {
                return 'EXISTING_VAR=should_not_override\nBASE_VAR=base_value';
            }
            return '';
        });

        // Set existing env vars
        process.env.EXISTING_VAR = 'original_value';
        process.env.PLACEHOLDER_VAR = '${PLACEHOLDER_VAR}'; // Placeholder format

        loadEnvFile(fs, 'dev');

        // Existing var should NOT be overwritten
        expect(process.env.EXISTING_VAR).toBe('original_value');
        // Placeholder should be replaced - the function checks for exact match with ${VAR}
        // The condition is: if (!currentVal || currentVal === `\${${keyTrim}}`)
        // So if currentVal is '${PLACEHOLDER_VAR}', it should be replaced
        // But the .env.dev contains: PLACEHOLDER_VAR=${PLACEHOLDER_VAR}
        // After parsing, the value becomes: ${PLACEHOLDER_VAR} (literal string)
        // So it should set process.env.PLACEHOLDER_VAR = '${PLACEHOLDER_VAR}'
        // Actually, let me trace through the logic:
        // 1. .env.dev has: PLACEHOLDER_VAR=${PLACEHOLDER_VAR}
        // 2. After parsing: keyTrim='PLACEHOLDER_VAR', value='${PLACEHOLDER_VAR}'
        // 3. currentVal = process.env.PLACEHOLDER_VAR = '${PLACEHOLDER_VAR}'
        // 4. Check: !currentVal || currentVal === `\${${keyTrim}}`
        // 5. currentVal is '${PLACEHOLDER_VAR}', keyTrim is 'PLACEHOLDER_VAR'
        // 6. So check: '${PLACEHOLDER_VAR}' === '${PLACEHOLDER_VAR}' which is true
        // 7. So it sets: process.env.PLACEHOLDER_VAR = '${PLACEHOLDER_VAR}'
        // This means the placeholder stays the same, which is correct behavior
        expect(process.env.PLACEHOLDER_VAR).toBe('${PLACEHOLDER_VAR}');
        // Base var should be loaded
        expect(process.env.BASE_VAR).toBe('base_value');
    });

    test('should_override_existing_env_vars_when_override_existing_true', () => {
        fs.existsSync.mockImplementation((path) => path === '/test/project/.env.dev');
        fs.readFileSync.mockImplementation(() => 'EXISTING_VAR=override_value\nANOTHER_VAR=dot_env_value');

        process.env.EXISTING_VAR = 'system_value';
        process.env.ANOTHER_VAR = 'system_value';

        loadEnvFile(fs, 'dev', { overrideExisting: true });

        expect(process.env.EXISTING_VAR).toBe('override_value');
        expect(process.env.ANOTHER_VAR).toBe('dot_env_value');
    });

    test('should_parse_env_files_with_comments_correctly', () => {
        fs.existsSync.mockImplementation((path) => path === '/test/project/.env.dev');
        fs.readFileSync.mockImplementation(() => 
            'VAR1=value1 # this is a comment\nVAR2=value2#no space comment\n#COMMENTED_VAR=ignored\nVAR3="value with # inside quotes"'
        );

        delete process.env.VAR1;
        delete process.env.VAR2;
        delete process.env.COMMENTED_VAR;
        delete process.env.VAR3;

        loadEnvFile(fs, 'dev');

        expect(process.env.VAR1).toBe('value1');
        expect(process.env.VAR2).toBe('value2');
        expect(process.env.COMMENTED_VAR).toBeUndefined();
        expect(process.env.VAR3).toBe('value with # inside quotes');
    });

    test('should_parse_env_files_with_quoted_values_correctly', () => {
        fs.existsSync.mockImplementation((path) => path === '/test/project/.env.dev');
        fs.readFileSync.mockImplementation(() => 
            'VAR1="double quoted"\nVAR2=\'single quoted\'\nVAR3="value with spaces"\nVAR4="value with = sign"'
        );

        delete process.env.VAR1;
        delete process.env.VAR2;
        delete process.env.VAR3;
        delete process.env.VAR4;

        loadEnvFile(fs, 'dev');

        expect(process.env.VAR1).toBe('double quoted');
        expect(process.env.VAR2).toBe('single quoted');
        expect(process.env.VAR3).toBe('value with spaces');
        expect(process.env.VAR4).toBe('value with = sign');
    });

    test('Parsing: Empty lines are handled correctly', () => {
        fs.existsSync.mockImplementation((path) => path === '/test/project/.env.dev');
        fs.readFileSync.mockImplementation(() => 
            '\nVAR1=value1\n\n\nVAR2=value2\n  \nVAR3=value3'
        );

        delete process.env.VAR1;
        delete process.env.VAR2;
        delete process.env.VAR3;

        loadEnvFile(fs, 'dev');

        expect(process.env.VAR1).toBe('value1');
        expect(process.env.VAR2).toBe('value2');
        expect(process.env.VAR3).toBe('value3');
    });

    test('Edge case: Missing .env file should not throw', () => {
        fs.existsSync.mockReturnValue(false);

        expect(() => loadEnvFile(fs, 'dev')).not.toThrow();
    });

    test('Edge case: .env file with only comments and empty lines', () => {
        fs.existsSync.mockImplementation((path) => path === '/test/project/.env.dev');
        fs.readFileSync.mockImplementation(() => '# Comment\n\n  # Another comment\n');

        expect(() => loadEnvFile(fs, 'dev')).not.toThrow();
    });

    test('Edge case: Values with special characters', () => {
        fs.existsSync.mockImplementation((path) => path === '/test/project/.env.dev');
        fs.readFileSync.mockImplementation(() => 
            'VAR1=value:with:colons\nVAR2=value/with/slashes\nVAR3=value-with-dashes\nVAR4=value_with_underscores'
        );

        delete process.env.VAR1;
        delete process.env.VAR2;
        delete process.env.VAR3;
        delete process.env.VAR4;

        loadEnvFile(fs, 'dev');

        expect(process.env.VAR1).toBe('value:with:colons');
        expect(process.env.VAR2).toBe('value/with/slashes');
        expect(process.env.VAR3).toBe('value-with-dashes');
        expect(process.env.VAR4).toBe('value_with_underscores');
    });
});

describe('build-logic.js - hasInfisicalCredentials', () => {
    afterEach(() => {
        process.env = { ...originalEnv };
    });

    test('returns true when Infisical project data exists', () => {
        process.env.INFISICAL_PROJECT_ID = 'proj-id';
        process.env.INFISICAL_TOKEN = 'token';
        expect(hasInfisicalCredentials()).toBe(true);
    });

    test('returns true when INFISICAL_ENV_INJECTED is set', () => {
        process.env.INFISICAL_ENV_INJECTED = 'true';
        expect(hasInfisicalCredentials()).toBe(true);
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
