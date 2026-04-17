import { describe, it, expect } from 'vitest';
import { shouldIgnore, matchPattern } from '../../../src/domain/PathResolver.js';

describe('PathResolver Security Tests', () => {
    it('should ignore paths using wildcard rules safely without regex injection', () => {
        // Regex injection attempt
        const maliciousRule = 'file*.txt.*';
        const maliciousRule2 = 'file*.txt[a-z]+';

        const ignoreRules = [maliciousRule, maliciousRule2];

        expect(shouldIgnore('file1.txt.zip', ignoreRules)).toBe(true);
        expect(shouldIgnore('file1.txta', ignoreRules)).toBe(false);
        // Before escaping, 'file*.txt[a-z]+' would match 'file1.txta' as a regex.
        // After escaping, it should literally look for '[a-z]+'
        expect(shouldIgnore('file1.txt[a-z]+', ignoreRules)).toBe(true);
    });

    it('should safely match pattern with potential regex characters', () => {
        // Normal wildcard use
        expect(matchPattern('image.png', '*.png')).toBe(true);
        expect(matchPattern('doc(1).pdf', 'doc(*).pdf')).toBe(true);

        // Before escaping, 'doc(*).pdf' regex `^doc(.*).pdf$`
        // which matches 'doc123.pdf', 'doc(1).pdf'.
        // Actually, without escaping `(`, `)` they act as regex groups.
        // If we escape everything except `*`, it should literally match `doc(1).pdf` and NOT `doc123.pdf`
        expect(matchPattern('doc123.pdf', 'doc(*).pdf')).toBe(false);
    });
});
