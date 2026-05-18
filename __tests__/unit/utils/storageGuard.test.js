import { describe, expect, test, vi } from 'vitest';
import {
  InsufficientStorageError,
  assertLocalStorageCapacity,
  getRequiredStorageBytes,
  resolveStorageGuardConfig
} from '../../../src/utils/storageGuard.js';

const createFsMock = (statfsResult) => ({
  constants: { W_OK: 2 },
  promises: {
    mkdir: vi.fn().mockResolvedValue(),
    access: vi.fn().mockResolvedValue(),
    statfs: vi.fn().mockResolvedValue(statfsResult)
  }
});

describe('storageGuard', () => {
  test('calculates required bytes from expected size plus headroom', () => {
    expect(getRequiredStorageBytes(1000, {
      requiredHeadroomRatio: 0.1,
      requiredHeadroomBytes: 256
    })).toBe(1356);
  });

  test('normalizes local storage guard config', () => {
    expect(resolveStorageGuardConfig({
      localStorage: {
        requiredHeadroomRatio: 2,
        requiredHeadroomBytes: 1024
      }
    })).toEqual({
      requiredHeadroomRatio: 1,
      requiredHeadroomBytes: 1024
    });
  });

  test('passes when available storage covers expected bytes and headroom', async () => {
    const fsMock = createFsMock({ bsize: 4096, bavail: 1000 });

    const result = await assertLocalStorageCapacity({
      dirPath: '/tmp/downloads',
      expectedBytes: 1024,
      config: {
        localStorage: {
          requiredHeadroomRatio: 0,
          requiredHeadroomBytes: 1024
        }
      },
      fsImpl: fsMock
    });

    expect(result.availableBytes).toBe(4096000);
    expect(fsMock.promises.mkdir).toHaveBeenCalledWith('/tmp/downloads', { recursive: true });
    expect(fsMock.promises.access).toHaveBeenCalledWith('/tmp/downloads', 2);
  });

  test('throws a typed error before local staging when storage is insufficient', async () => {
    const fsMock = createFsMock({ bsize: 4096, bavail: 1 });

    await expect(assertLocalStorageCapacity({
      dirPath: '/tmp/downloads',
      expectedBytes: 10 * 1024 * 1024,
      config: {
        localStorage: {
          requiredHeadroomRatio: 0,
          requiredHeadroomBytes: 1024
        }
      },
      purpose: 'test download',
      fsImpl: fsMock
    })).rejects.toBeInstanceOf(InsufficientStorageError);
  });

  test('fails closed when the staging directory is not configured', async () => {
    const fsMock = createFsMock({ bsize: 4096, bavail: 1000 });

    await expect(assertLocalStorageCapacity({
      dirPath: '',
      expectedBytes: 1024,
      fsImpl: fsMock
    })).rejects.toMatchObject({
      code: 'INSUFFICIENT_STORAGE'
    });

    expect(fsMock.promises.mkdir).not.toHaveBeenCalled();
  });
});
