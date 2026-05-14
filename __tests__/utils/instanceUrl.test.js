import { describe, it, expect } from 'vitest';
import { normalizePublicUrl, resolveInstanceBaseUrl } from '../../src/utils/instanceUrl.js';

describe('instanceUrl SSOT helpers', () => {
    it('should normalize URLs consistently', () => {
        expect(normalizePublicUrl('https://example.com/path/')).toBe('https://example.com/path');
        expect(normalizePublicUrl('')).toBeNull();
        expect(normalizePublicUrl('not-a-url')).toBeNull();
    });

    it('should resolve instance base URL with shared priority order', () => {
        expect(resolveInstanceBaseUrl({
            directUrl: 'https://direct.example.com/',
            tunnelUrl: 'https://tunnel.example.com/',
            url: 'https://fallback.example.com/'
        })).toBe('https://direct.example.com');

        expect(resolveInstanceBaseUrl({
            tunnelUrl: 'https://tunnel.example.com/',
            url: 'https://fallback.example.com/'
        })).toBe('https://tunnel.example.com');

        expect(resolveInstanceBaseUrl({
            url: 'https://fallback.example.com/'
        })).toBe('https://fallback.example.com');
    });
});
