import { describe, expect, test } from 'vitest';

import {
  buildDockerBuildxArgs,
  buildDockerIdentityArgs,
  getCiPlan,
  normalizeCommand,
  resolveCiMode
} from '../../scripts/ci-unified.js';

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

  test('should build release identity docker args from git context', () => {
    expect(buildDockerIdentityArgs({
      nodeEnv: 'prod',
      version: '4.33.1',
      sha: 'abcdef1234567890',
      shortSha: 'abcdef1',
      imageTag: 'ghcr.io/owner/repo:sha-abcdef1',
      buildTime: '2026-05-18T00:00:00.000Z'
    })).toEqual([
      'NODE_ENV=prod',
      'APP_VERSION=4.33.1',
      'GIT_SHA=abcdef1234567890',
      'BUILD_TIME=2026-05-18T00:00:00.000Z',
      'IMAGE_TAG=ghcr.io/owner/repo:sha-abcdef1',
      'RELEASE_ID=4.33.1+abcdef123456'
    ]);
  });

  test('should build docker publish args without shell splitting', () => {
    expect(buildDockerBuildxArgs({
      output: '--push',
      platforms: 'linux/amd64,linux/arm64',
      buildArgs: [
        'NODE_ENV=prod',
        'BUILD_TIME=2026-05-18T00:00:00.000Z'
      ],
      tags: [
        'ghcr.io/owner/repo:sha-abcdef1',
        'ghcr.io/owner/repo:latest'
      ],
      cacheFromImage: 'ghcr.io/owner/repo:latest'
    })).toEqual([
      'buildx',
      'build',
      '.',
      '--push',
      '--platform',
      'linux/amd64,linux/arm64',
      '--build-arg',
      'NODE_ENV=prod',
      '--build-arg',
      'BUILD_TIME=2026-05-18T00:00:00.000Z',
      '-t',
      'ghcr.io/owner/repo:sha-abcdef1',
      '-t',
      'ghcr.io/owner/repo:latest',
      '--cache-from',
      'type=registry,ref=ghcr.io/owner/repo:latest',
      '--cache-to',
      'type=inline'
    ]);
  });
});
