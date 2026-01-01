import Ajv from 'ajv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

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

validateManifest();
