const { normalizeNodeEnv, mapNodeEnvToInfisicalEnv } = await import('../../../src/utils/envMapper.js');

describe('envMapper', () => {
    test('normalizeNodeEnv should normalize production to prod', () => {
        expect(normalizeNodeEnv('production')).toBe('prod');
    });

    test('normalizeNodeEnv should normalize development to dev', () => {
        expect(normalizeNodeEnv('development')).toBe('dev');
    });

    test('normalizeNodeEnv should normalize staging to pre', () => {
        expect(normalizeNodeEnv('staging')).toBe('pre');
    });

    test('normalizeNodeEnv should keep prod as prod', () => {
        expect(normalizeNodeEnv('prod')).toBe('prod');
    });

    test('normalizeNodeEnv should keep dev as dev', () => {
        expect(normalizeNodeEnv('dev')).toBe('dev');
    });

    test('normalizeNodeEnv should keep pre as pre', () => {
        expect(normalizeNodeEnv('pre')).toBe('pre');
    });

    test('normalizeNodeEnv should keep test as test', () => {
        expect(normalizeNodeEnv('test')).toBe('test');
    });

    test('normalizeNodeEnv should default to dev for null or empty', () => {
        expect(normalizeNodeEnv(null)).toBe('dev');
        expect(normalizeNodeEnv('')).toBe('dev');
        expect(normalizeNodeEnv(undefined)).toBe('dev');
    });

    test('normalizeNodeEnv should default to dev for invalid values', () => {
        expect(normalizeNodeEnv('invalid')).toBe('dev');
        expect(normalizeNodeEnv('random')).toBe('dev');
    });

    test('mapNodeEnvToInfisicalEnv should map dev to dev', () => {
        expect(mapNodeEnvToInfisicalEnv('dev')).toBe('dev');
    });

    test('mapNodeEnvToInfisicalEnv should map prod to prod', () => {
        expect(mapNodeEnvToInfisicalEnv('prod')).toBe('prod');
    });

    test('mapNodeEnvToInfisicalEnv should map pre to pre', () => {
        expect(mapNodeEnvToInfisicalEnv('pre')).toBe('pre');
    });

    test('mapNodeEnvToInfisicalEnv should map test to dev', () => {
        expect(mapNodeEnvToInfisicalEnv('test')).toBe('dev');
    });

    test('mapNodeEnvToInfisicalEnv should default to dev for invalid values', () => {
        expect(mapNodeEnvToInfisicalEnv('invalid')).toBe('dev');
    });
});