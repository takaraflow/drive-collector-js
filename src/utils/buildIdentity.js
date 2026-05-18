import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const UNKNOWN = 'unknown';
const BUILD_SHORT_SHA_LENGTH = 12;

let packageVersion = UNKNOWN;

try {
    const pkg = require('../../package.json');
    packageVersion = normalizeIdentityValue(pkg?.version);
} catch {
    packageVersion = UNKNOWN;
}

function normalizeIdentityValue(value) {
    if (value === undefined || value === null) return UNKNOWN;
    const normalized = String(value).trim();
    return normalized || UNKNOWN;
}

function firstKnown(...values) {
    for (const value of values) {
        const normalized = normalizeIdentityValue(value);
        if (normalized !== UNKNOWN) return normalized;
    }
    return UNKNOWN;
}

export function isKnownBuildValue(value) {
    return normalizeIdentityValue(value) !== UNKNOWN;
}

export function getBuildShortGitSha(gitSha) {
    const normalized = normalizeIdentityValue(gitSha);
    return normalized !== UNKNOWN ? normalized.slice(0, BUILD_SHORT_SHA_LENGTH) : UNKNOWN;
}

export function getBuildReleaseId(version, gitSha) {
    const normalizedVersion = normalizeIdentityValue(version);
    const shortGitSha = getBuildShortGitSha(gitSha);
    return isKnownBuildValue(shortGitSha) ? `${normalizedVersion}+${shortGitSha}` : normalizedVersion;
}

export function getBuildIdentity(env = process.env) {
    const version = firstKnown(env.APP_VERSION, packageVersion);
    const gitSha = firstKnown(
        env.GIT_SHA,
        env.BUILD_SHA,
        env.COMMIT_SHA,
        env.GITHUB_SHA,
        env.SOURCE_VERSION
    );
    const shortGitSha = getBuildShortGitSha(gitSha);
    const buildTime = firstKnown(env.BUILD_TIME, env.BUILD_DATE);
    const imageTag = firstKnown(env.IMAGE_TAG, env.CONTAINER_IMAGE, env.DOCKER_IMAGE_TAG);
    const releaseId = firstKnown(
        env.RELEASE_ID,
        getBuildReleaseId(version, gitSha)
    );

    return Object.freeze({
        serviceName: firstKnown(env.NEW_RELIC_APP_NAME, env.APP_NAME, 'drive-collector'),
        version,
        packageVersion,
        gitSha,
        shortGitSha,
        buildTime,
        imageTag,
        releaseId
    });
}

export function getBuildDisplayVersion(identity = getBuildIdentity()) {
    if (isKnownBuildValue(identity.shortGitSha)) {
        return `${identity.version}+${identity.shortGitSha}`;
    }
    return identity.version;
}

export function getBuildLogFields(identity = getBuildIdentity()) {
    return {
        version: identity.version,
        package_version: identity.packageVersion,
        git_sha: identity.gitSha,
        git_short_sha: identity.shortGitSha,
        build_time: identity.buildTime,
        image_tag: identity.imageTag,
        release_id: identity.releaseId
    };
}

export function getBuildResourceAttributes(identity = getBuildIdentity()) {
    return Object.fromEntries(
        Object.entries({
            'service.version': identity.version,
            'app.package_version': identity.packageVersion,
            'app.release_id': identity.releaseId,
            'git.sha': identity.gitSha,
            'git.short_sha': identity.shortGitSha,
            'build.time': identity.buildTime,
            'container.image.tag': identity.imageTag
        }).filter(([, value]) => isKnownBuildValue(value))
    );
}
