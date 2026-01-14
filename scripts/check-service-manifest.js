import fs from 'fs';
import path from 'path';
import process from 'process';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const repoRoot = process.cwd();
  const manifestPath = path.join(repoRoot, 'manifest.json');
  const serviceManifestPath = path.join(repoRoot, 'src', 'config', 'service-manifest.json');

  if (!fs.existsSync(manifestPath)) {
    console.error(`Missing manifest.json at ${manifestPath}`);
    process.exit(2);
  }
  if (!fs.existsSync(serviceManifestPath)) {
    console.error(`Missing service manifest at ${serviceManifestPath}`);
    process.exit(2);
  }

  const manifest = readJson(manifestPath);
  const serviceManifest = readJson(serviceManifestPath);

  const manifestEnvKeys = new Set(Object.keys(manifest?.config?.env || {}));
  const serviceMappings = serviceManifest?.serviceMappings || {};

  const missing = [];

  for (const [serviceName, service] of Object.entries(serviceMappings)) {
    const configKeys = Array.isArray(service?.configKeys) ? service.configKeys : [];
    for (const key of configKeys) {
      if (!manifestEnvKeys.has(key)) {
        missing.push({ serviceName, key });
      }
    }
  }

  if (missing.length) {
    console.error(`[service-manifest] ${missing.length} configKeys not found in manifest.json config.env:`);
    for (const { serviceName, key } of missing.sort((a, b) => `${a.serviceName}:${a.key}`.localeCompare(`${b.serviceName}:${b.key}`))) {
      console.error(`- ${serviceName}: ${key}`);
    }
    console.error(`\nFix: add missing keys to manifest.json config.env, or remove them from src/config/service-manifest.json.`);
    process.exit(1);
  }

  console.log(`[service-manifest] OK: all configKeys exist in manifest.json config.env.`);
}

main();

