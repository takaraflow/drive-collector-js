import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const UNKNOWN = 'unknown';
const BUILD_SHORT_SHA_LENGTH = 12;
const SERVICE_NAME_ENV_KEYS = Object.freeze(['NEW_RELIC_APP_NAME', 'APP_NAME']);
const VERSION_ENV_KEYS = Object.freeze(['APP_VERSION']);
const GIT_SHA_ENV_KEYS = Object.freeze([
    'GIT_SHA',
    'BUILD_SHA',
    'COMMIT_SHA',
    'GITHUB_SHA',
    'SOURCE_VERSION',
    'NF_DEPLOYMENT_SHA'
]);
const BUILD_TIME_ENV_KEYS = Object.freeze(['BUILD_TIME', 'BUILD_DATE']);
const IMAGE_TAG_ENV_KEYS = Object.freeze(['IMAGE_TAG', 'CONTAINER_IMAGE', 'DOCKER_IMAGE_TAG', 'NF_IMAGE']);
const RELEASE_ID_ENV_KEYS = Object.freeze(['RELEASE_ID']);

export const BUILD_IDENTITY_ENV_KEY_GROUPS = Object.freeze({
    serviceName: SERVICE_NAME_ENV_KEYS,
    version: VERSION_ENV_KEYS,
    gitSha: GIT_SHA_ENV_KEYS,
    buildTime: BUILD_TIME_ENV_KEYS,
    imageTag: IMAGE_TAG_ENV_KEYS,
    releaseId: RELEASE_ID_ENV_KEYS
});

export const BUILD_IDENTITY_EARLY_ENV_KEY_GROUPS = Object.freeze(Object.values(BUILD_IDENTITY_ENV_KEY_GROUPS));

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
    const version = firstKnown(...VERSION_ENV_KEYS.map(key => env[key]), packageVersion);
    const gitSha = firstKnown(...GIT_SHA_ENV_KEYS.map(key => env[key]));
    const shortGitSha = getBuildShortGitSha(gitSha);
    const buildTime = firstKnown(...BUILD_TIME_ENV_KEYS.map(key => env[key]));
    const imageTag = firstKnown(...IMAGE_TAG_ENV_KEYS.map(key => env[key]));
    const releaseId = firstKnown(
        ...RELEASE_ID_ENV_KEYS.map(key => env[key]),
        getBuildReleaseId(version, gitSha)
    );

    return Object.freeze({
        serviceName: firstKnown(...SERVICE_NAME_ENV_KEYS.map(key => env[key]), 'drive-collector'),
        version,
        packageVersion,
        gitSha,
        shortGitSha,
        buildTime,
        imageTag,
        releaseId
    });
}

export function getPublicBuildIdentity(identity = getBuildIdentity()) {
    return Object.freeze({
        serviceName: identity.serviceName,
        version: identity.version,
        shortGitSha: identity.shortGitSha,
        releaseId: identity.releaseId
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
