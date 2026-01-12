import BaseSecretsProvider from '../../../src/services/secrets/BaseSecretsProvider.js';
import { describe, expect, it } from 'vitest';

describe('BaseSecretsProvider', () => {
  it('should be defined', () => {
    expect(new BaseSecretsProvider()).toBeDefined();
  });
});
