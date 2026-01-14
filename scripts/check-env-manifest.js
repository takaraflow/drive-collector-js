import fs from 'fs';
import path from 'path';
import process from 'process';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function listFilesRecursive(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'coverage' || entry.name === 'test-results') continue;
      files.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(fullPath);
    }
  }
  return files;
}

function extractEnvKeysFromContent(filePath, content) {
  const keys = new Set();

  const processEnvRegex = /process\.env\.([A-Z0-9_]+)/g;
  for (const match of content.matchAll(processEnvRegex)) {
    keys.add(match[1]);
  }

  const hasEnvAlias = /\bconst\s+env\s*=\s*process\.env\b/.test(content) || /\blet\s+env\s*=\s*process\.env\b/.test(content);
  if (hasEnvAlias) {
    const envAliasRegex = /\benv\.([A-Z0-9_]+)/g;
    for (const match of content.matchAll(envAliasRegex)) {
      keys.add(match[1]);
    }
  }

  // Ignore false positives that are very likely not process env keys
  // (e.g. process.env['X'] is not covered by regex, and lowercase env keys are ignored by design)
  return { filePath, keys: Array.from(keys).sort() };
}

function loadManifestEnvKeys(manifestPath) {
  const manifest = readJson(manifestPath);
  const envConfig = manifest?.config?.env || {};
  return new Set(Object.keys(envConfig));
}

function main() {
  const repoRoot = process.cwd();
  const manifestPath = path.join(repoRoot, 'manifest.json');
  const srcPath = path.join(repoRoot, 'src');

  if (!fs.existsSync(manifestPath)) {
    console.error(`Missing manifest.json at ${manifestPath}`);
    process.exit(2);
  }
  if (!fs.existsSync(srcPath)) {
    console.error(`Missing src/ at ${srcPath}`);
    process.exit(2);
  }

  const manifestKeys = loadManifestEnvKeys(manifestPath);
  const jsFiles = listFilesRecursive(srcPath);

  const usedKeys = new Map(); // key -> Set(files)
  for (const filePath of jsFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const { keys } = extractEnvKeysFromContent(filePath, content);
    for (const key of keys) {
      if (!usedKeys.has(key)) usedKeys.set(key, new Set());
      usedKeys.get(key).add(path.relative(repoRoot, filePath));
    }
  }

  const missing = [];
  for (const [key, files] of usedKeys.entries()) {
    if (!manifestKeys.has(key)) {
      missing.push({ key, files: Array.from(files).sort() });
    }
  }

  if (missing.length) {
    console.error(`[env-manifest] Missing ${missing.length} env key(s) in manifest.json config.env:`);
    for (const item of missing.sort((a, b) => a.key.localeCompare(b.key))) {
      console.error(`- ${item.key} (referenced in: ${item.files.join(', ')})`);
    }
    console.error(`\nFix: add these keys to manifest.json under config.env (or refactor code to stop using them).`);
    process.exit(1);
  }

  console.log(`[env-manifest] OK: all env keys referenced in src/ exist in manifest.json config.env (${usedKeys.size} keys checked).`);
}

main();

