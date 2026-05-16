import { describe, expect, test } from 'vitest';

import { getCiPlan, normalizeCommand, resolveCiMode } from '../../scripts/ci-unified.js';

describe('ci-unified command planning', () => {
  test('should reject unknown commands', () => {
    expect(() => normalizeCommand('unknown')).toThrow('未知 CI 命令');
  });

  test('should map direct commands to focused plans', () => {
    expect(getCiPlan('lint')).toEqual(['validate', 'install', 'lint']);
    expect(getCiPlan('test')).toEqual(['validate', 'install', 'test']);
    expect(getCiPlan('build')).toEqual(['validate', 'install', 'docker']);
    expect(getCiPlan('sync')).toEqual(['validate', 'static']);
  });

  test('should honor CI_MODE for the full command', () => {
    expect(resolveCiMode('full', { CI_MODE: 'lint-only' })).toBe('lint-only');
    expect(getCiPlan('full', { CI_MODE: 'test-only' })).toEqual(['validate', 'install', 'test']);
    expect(getCiPlan('full', { CI_MODE: 'build-only' })).toEqual(['validate', 'install', 'docker']);
  });

  test('should reject unknown CI_MODE values', () => {
    expect(() => getCiPlan('full', { CI_MODE: 'not-a-mode' })).toThrow('未知 CI_MODE');
  });
});
