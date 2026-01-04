import Ajv from 'ajv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

/**
 * 检查 package.json 和 manifest.json 的版本是否同步
 */
async function checkVersionSync() {
  try {
    const packageJsonPath = join(projectRoot, 'package.json');
    const manifestJsonPath = join(projectRoot, 'manifest.json');

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const manifestJson = JSON.parse(readFileSync(manifestJsonPath, 'utf-8'));

    if (packageJson.version !== manifestJson.version) {
      console.error(`❌ Version mismatch between package.json (${packageJson.version}) and manifest.json (${manifestJson.version}).`);
      process.exit(1);
    } else {
      console.log(`✅ Version check passed: package.json and manifest.json are in sync (v${packageJson.version}).`);
    }
  } catch (error) {
    console.error(`❌ Failed to check version sync: ${error.message}`);
    process.exit(1);
  }
}

async function validateManifest() {
  try {
    // 读取 manifest.json
    const manifestPath = join(projectRoot, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    // 读取 schema
    const schemaPath = join(projectRoot, 'tests', 'manifest.schema.json');
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

    // 初始化 Ajv
    const ajv = new Ajv({
      allErrors: true,
      verbose: true
    });

    const validate = ajv.compile(schema);
    const valid = validate(manifest);

    if (!valid) {
      console.error('❌ Manifest validation failed:');
      validate.errors.forEach(err => {
        console.error(`- ${err.instancePath || 'root'} ${err.message}`);
        if (err.params) {
          console.error(`  Params: ${JSON.stringify(err.params)}`);
        }
      });
      process.exit(1);
    }

    console.log('✅ Manifest validation passed');
  } catch (error) {
    console.error('❌ Error during manifest validation:', error.message);
    process.exit(1);
  }
}

// 执行版本同步检查和 Manifest 验证
(async () => {
  await checkVersionSync();
  await validateManifest();
})();
