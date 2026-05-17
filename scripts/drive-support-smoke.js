#!/usr/bin/env node
import { readFileSync } from 'fs';
import { pathToFileURL } from 'url';

const DEFAULT_CONFIG_JSON_ENV = 'DRIVE_SMOKE_CONFIG_JSON';
const DEFAULT_CONFIG_FILE_ENV = 'DRIVE_SMOKE_CONFIG_FILE';
const DEFAULT_TYPES_ENV = 'DRIVE_SMOKE_TYPES';
const DEFAULT_REQUIRE_ENV = 'DRIVE_SMOKE_REQUIRED';
const SECRET_KEYS = new Set([
  'ak',
  'access_key_id',
  'access_token',
  'client_secret',
  'pass',
  'password',
  'refresh_token',
  'secret',
  'secret_access_key',
  'sk',
  'token'
]);
const SECRET_KEY_PATTERN = [...SECRET_KEYS]
  .sort((a, b) => b.length - a.length)
  .map(escapeRegExp)
  .join('|');
const QUOTED_VALUE_PATTERN = String.raw`(?:\\.|[^"\\])*`;
const SINGLE_QUOTED_VALUE_PATTERN = String.raw`(?:\\.|[^'\\])*`;

export function parseArgs(argv = []) {
  const options = {
    configJson: null,
    configFile: null,
    requireConfig: false,
    types: [],
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, null];
    const nextValue = () => {
      const value = inlineValue ?? argv[++index];
      if (value === undefined || value.startsWith('--') || String(value).trim() === '') {
        throw new Error(`${name} requires a value`);
      }
      return value;
    };

    switch (name) {
      case '--config-json':
        options.configJson = nextValue();
        break;
      case '--config-file':
        options.configFile = nextValue();
        break;
      case '--types': {
        const types = parseTypes(nextValue());
        if (types.length === 0) {
          throw new Error(`${name} requires at least one provider type`);
        }
        options.types = types;
        break;
      }
      case '--require-config':
        options.requireConfig = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function parseTypes(value) {
  return String(value || '')
    .split(',')
    .map(type => type.trim())
    .filter(Boolean);
}

export function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function normalizeSmokeConfig(input) {
  if (!input) return [];

  if (Array.isArray(input)) {
    return input.map(normalizeEntry);
  }

  if (typeof input === 'object') {
    if (Array.isArray(input.providers)) {
      return input.providers.map(normalizeEntry);
    }

    if (input.type && input.config) {
      return [normalizeEntry(input)];
    }

    return Object.entries(input).map(([type, config]) => normalizeEntry({ type, config }));
  }

  throw new Error('Drive smoke config must be a JSON object or array');
}

export function loadSmokeConfig({ options = {}, env = process.env, readFile = readFileSync } = {}) {
  if (options.configJson) {
    return {
      source: '--config-json',
      entries: normalizeSmokeConfig(JSON.parse(options.configJson))
    };
  }

  if (options.configFile) {
    return {
      source: options.configFile,
      entries: normalizeSmokeConfig(JSON.parse(readFile(options.configFile, 'utf8')))
    };
  }

  if (env[DEFAULT_CONFIG_JSON_ENV]) {
    return {
      source: DEFAULT_CONFIG_JSON_ENV,
      entries: normalizeSmokeConfig(JSON.parse(env[DEFAULT_CONFIG_JSON_ENV]))
    };
  }

  if (env[DEFAULT_CONFIG_FILE_ENV]) {
    return {
      source: env[DEFAULT_CONFIG_FILE_ENV],
      entries: normalizeSmokeConfig(JSON.parse(readFile(env[DEFAULT_CONFIG_FILE_ENV], 'utf8')))
    };
  }

  return { source: null, entries: [] };
}

export function redactForLog(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';

  return text
    .replace(new RegExp(`(\\b(?:${SECRET_KEY_PATTERN})\\s*=\\s*")${QUOTED_VALUE_PATTERN}(")`, 'gi'), '$1[REDACTED]$2')
    .replace(new RegExp(`(\\b(?:${SECRET_KEY_PATTERN})\\s*=\\s*')${SINGLE_QUOTED_VALUE_PATTERN}(')`, 'gi'), '$1[REDACTED]$2')
    .replace(new RegExp(`("\\b(?:${SECRET_KEY_PATTERN})"\\s*:\\s*")${QUOTED_VALUE_PATTERN}(")`, 'gi'), '$1[REDACTED]$2')
    .replace(new RegExp(`(\\b(?:${SECRET_KEY_PATTERN})"\\s*:\\s*")${QUOTED_VALUE_PATTERN}(")`, 'gi'), '$1[REDACTED]$2')
    .replace(new RegExp(`(\\\\"\\b(?:${SECRET_KEY_PATTERN})\\\\"\\s*:\\s*\\\\")${QUOTED_VALUE_PATTERN}(\\\\")`, 'gi'), '$1[REDACTED]$2')
    .replace(new RegExp(`\\b(${SECRET_KEY_PATTERN})\\s*=\\s*(?!["'])[^\\s,]+`, 'gi'), '$1=[REDACTED]')
    .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[REDACTED]');
}

export function redactConfig(config) {
  if (!config || typeof config !== 'object') return config;
  return Object.fromEntries(Object.entries(config).map(([key, value]) => {
    if (SECRET_KEYS.has(key.toLowerCase())) {
      return [key, '[REDACTED]'];
    }
    return [key, value];
  }));
}

export function usage() {
  return [
    'Usage: node scripts/drive-support-smoke.js [--config-json JSON | --config-file PATH] [--types mega,webdav] [--require-config]',
    '',
    'Config formats:',
    '  {"mega":{"user":"name@example.com","pass":"secret"}}',
    '  {"providers":[{"type":"webdav","config":{"url":"https://dav.example.com","user":"u","pass":"p"}}]}',
    '',
    `Env alternatives: ${DEFAULT_CONFIG_JSON_ENV}, ${DEFAULT_CONFIG_FILE_ENV}, ${DEFAULT_TYPES_ENV}, ${DEFAULT_REQUIRE_ENV}=true`
  ].join('\n');
}

export async function runDriveSupportSmoke({
  argv = [],
  env = process.env,
  factory = null,
  loadFactory = loadDefaultFactory,
  readFile = readFileSync,
  stdout = console.log,
  stderr = console.error
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(`[drive-smoke] FAIL: ${error.message}`);
    stderr(usage());
    return { exitCode: 2, status: 'failed', results: [] };
  }

  if (options.help) {
    stdout(usage());
    return { exitCode: 0, status: 'help', results: [] };
  }

  options.requireConfig = options.requireConfig || isTruthy(env[DEFAULT_REQUIRE_ENV]);
  if (options.types.length === 0) {
    options.types = parseTypes(env[DEFAULT_TYPES_ENV]);
  }

  let loaded;
  try {
    loaded = loadSmokeConfig({ options, env, readFile });
  } catch (error) {
    stderr(`[drive-smoke] FAIL: unable to load config: ${redactForLog(error.message)}`);
    return { exitCode: 2, status: 'failed', results: [] };
  }

  const selectedTypes = new Set(options.types);
  const entries = selectedTypes.size > 0
    ? loaded.entries.filter(entry => selectedTypes.has(entry.type))
    : loaded.entries;

  if (entries.length === 0) {
    const message = selectedTypes.size > 0
      ? `no smoke config entries matched requested types: ${[...selectedTypes].join(', ')}`
      : `no smoke config provided; set ${DEFAULT_CONFIG_JSON_ENV} or ${DEFAULT_CONFIG_FILE_ENV}`;
    if (options.requireConfig) {
      stderr(`[drive-smoke] FAIL: ${message}`);
      return { exitCode: 1, status: 'failed', results: [] };
    }
    stdout(`[drive-smoke] SKIP: ${message}`);
    return { exitCode: 0, status: 'skipped', results: [] };
  }

  const activeFactory = factory || await loadFactory();
  const results = [];

  for (const entry of entries) {
    const result = await smokeOneProvider(activeFactory, entry);
    results.push(result);

    if (result.success) {
      stdout(`[drive-smoke] PASS ${result.type} (${result.supportLevel})`);
    } else {
      stderr(`[drive-smoke] FAIL ${result.type}: ${redactForLog(result.reason || 'validation failed')}`);
      if (result.details) {
        stderr(`[drive-smoke] details ${result.type}: ${redactForLog(result.details).slice(-500)}`);
      }
    }
  }

  const failures = results.filter(result => !result.success);
  const passed = results.length - failures.length;
  const status = failures.length > 0 ? 'failed' : 'passed';
  const output = failures.length > 0 ? stderr : stdout;
  output(`[drive-smoke] ${status.toUpperCase()}: ${passed}/${results.length} provider(s) passed`);

  return {
    exitCode: failures.length > 0 ? 1 : 0,
    status,
    results
  };
}

export async function smokeOneProvider(factory, entry) {
  if (!factory?.isSupported?.(entry.type)) {
    return {
      type: entry.type,
      supportLevel: 'unknown',
      success: false,
      reason: 'unsupported provider type'
    };
  }

  if (!entry.config || typeof entry.config !== 'object' || Array.isArray(entry.config)) {
    return {
      type: entry.type,
      supportLevel: 'unknown',
      success: false,
      reason: 'provider config must be an object'
    };
  }

  try {
    const provider = factory.getProvider(entry.type);
    const info = provider.getInfo();
    const validation = await provider.validateConfig(entry.config);

    return {
      type: entry.type,
      supportLevel: info.supportLevel || 'advanced',
      success: Boolean(validation?.success),
      reason: validation?.reason || null,
      details: validation?.details || null,
      config: redactConfig(entry.config)
    };
  } catch (error) {
    return {
      type: entry.type,
      supportLevel: 'unknown',
      success: false,
      reason: error.message
    };
  }
}

async function loadDefaultFactory() {
  const { DriveProviderFactory } = await import('../src/services/drives/index.js');
  return DriveProviderFactory;
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Drive smoke entry must be an object');
  }

  const type = String(entry.type || '').trim();
  if (!type) {
    throw new Error('Drive smoke entry missing type');
  }

  return {
    type,
    config: entry.config
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isCliEntrypoint(metaUrl = import.meta.url, argv = process.argv) {
  const entry = argv?.[1];
  if (typeof entry !== 'string' || entry.trim() === '') {
    return false;
  }
  return metaUrl === pathToFileURL(entry).href;
}

if (isCliEntrypoint()) {
  const result = await runDriveSupportSmoke({
    argv: process.argv.slice(2),
    env: process.env,
    loadFactory: loadDefaultFactory
  });
  process.exitCode = result.exitCode;
}
