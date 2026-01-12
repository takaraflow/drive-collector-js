import CloudSecretsProvider from '../../../src/services/secrets/CloudSecretsProvider.js';
import { describe, expect, it } from 'vitest';

describe('CloudSecretsProvider', () => {
  it('should be defined', () => {
    expect(new CloudSecretsProvider()).toBeDefined();
  });
});
