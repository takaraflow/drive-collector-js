import InfisicalSecretsProvider from '../../../src/services/secrets/InfisicalSecretsProvider.js';
import { describe, expect, it } from 'vitest';

describe('InfisicalSecretsProvider', () => {
  it('should be defined', () => {
    expect(new InfisicalSecretsProvider({})).toBeDefined();
  });
});
