const ENV_VERSION_KEYS = ['VERSION', '__VERSION__'];

export function resolveBuildVersion() {
  if (typeof globalThis !== 'undefined') {
    for (const key of ENV_VERSION_KEYS) {
      const val = globalThis[key];
      if (val !== undefined && val !== null && val !== '') return String(val);
    }
  }

  if (typeof process !== 'undefined' && process.env) {
    const envVersion = process.env.VERSION;
    if (envVersion) return String(envVersion);
  }

  return 'dev';
}

let BUILD_VERSION = resolveBuildVersion();
export let VERSION = BUILD_VERSION;

function syncGlobalVersion() {
  if (typeof globalThis !== 'undefined') {
    globalThis.VERSION = VERSION;
  }
}

export function updateVersionFromEnv(envVersion) {
  if (!envVersion) return;
  const normalized = String(envVersion).trim();
  if (!normalized) return;
  if (normalized === BUILD_VERSION) return;
  BUILD_VERSION = normalized;
  VERSION = BUILD_VERSION;
  syncGlobalVersion();
}

syncGlobalVersion();

