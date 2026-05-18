import { describe, expect, test } from 'vitest';

import {
    getBuildDisplayVersion,
    getBuildIdentity,
    getBuildLogFields,
    getBuildReleaseId,
    getBuildResourceAttributes,
    getBuildShortGitSha
} from '../../../src/utils/buildIdentity.js';

describe('buildIdentity', () => {
    test('should resolve release identity from deployment env', () => {
        const identity = getBuildIdentity({
            APP_VERSION: '4.33.1',
            GIT_SHA: 'abcdef1234567890',
            BUILD_TIME: '2026-05-18T00:00:00.000Z',
            IMAGE_TAG: 'ghcr.io/owner/repo:sha-abcdef1',
            NEW_RELIC_APP_NAME: 'drive-collector-prod'
        });

        expect(identity).toMatchObject({
            serviceName: 'drive-collector-prod',
            version: '4.33.1',
            gitSha: 'abcdef1234567890',
            shortGitSha: 'abcdef123456',
            buildTime: '2026-05-18T00:00:00.000Z',
            imageTag: 'ghcr.io/owner/repo:sha-abcdef1',
            releaseId: '4.33.1+abcdef123456'
        });
        expect(getBuildDisplayVersion(identity)).toBe('4.33.1+abcdef123456');
    });

    test('should expose consistent log and otel resource fields', () => {
        const identity = getBuildIdentity({
            APP_VERSION: '4.33.1',
            COMMIT_SHA: '1234567890abcdef',
            BUILD_DATE: '2026-05-18T01:00:00.000Z',
            CONTAINER_IMAGE: 'repo/app:main'
        });

        expect(getBuildLogFields(identity)).toEqual(expect.objectContaining({
            version: '4.33.1',
            git_sha: '1234567890abcdef',
            git_short_sha: '1234567890ab',
            build_time: '2026-05-18T01:00:00.000Z',
            image_tag: 'repo/app:main',
            release_id: '4.33.1+1234567890ab'
        }));

        expect(getBuildResourceAttributes(identity)).toEqual(expect.objectContaining({
            'service.version': '4.33.1',
            'git.sha': '1234567890abcdef',
            'git.short_sha': '1234567890ab',
            'build.time': '2026-05-18T01:00:00.000Z',
            'container.image.tag': 'repo/app:main',
            'app.release_id': '4.33.1+1234567890ab'
        }));
    });

    test('should use Northflank deployment metadata as platform fallback', () => {
        const identity = getBuildIdentity({
            APP_VERSION: '4.33.1',
            NF_DEPLOYMENT_SHA: 'd41160e0f6d175e511a87f6fbc3f18420f5b7f39',
            NF_IMAGE: 'registry.northflank.com/project/service:runtime-image'
        });

        expect(identity.gitSha).toBe('d41160e0f6d175e511a87f6fbc3f18420f5b7f39');
        expect(identity.shortGitSha).toBe('d41160e0f6d1');
        expect(identity.imageTag).toBe('registry.northflank.com/project/service:runtime-image');
        expect(identity.releaseId).toBe('4.33.1+d41160e0f6d1');
    });

    test('should derive short sha and release id from the same SSOT helper', () => {
        expect(getBuildShortGitSha('abcdef1234567890')).toBe('abcdef123456');
        expect(getBuildReleaseId('4.33.1', 'abcdef1234567890')).toBe('4.33.1+abcdef123456');
        expect(getBuildReleaseId('4.33.1', 'unknown')).toBe('4.33.1');
    });
});
