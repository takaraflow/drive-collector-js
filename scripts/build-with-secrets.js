#!/usr/bin/env node

/**
 * Enhanced build script with secrets orchestration
 * Integrates Infisical secrets management into the build process
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SecretsOrchestrator } from '../src/config/SecretsOrchestrator.js';
import dotenv from 'dotenv';
import { loadEnvFile, normalizeEnvName } from './build-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        env: 'dev',
        dryRun: false,
        skipSecrets: false,
        help: false
    };
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        if (arg.startsWith('--env=')) {
            options.env = arg.split('=')[1];
        } else if (arg === '--dry-run') {
            options.dryRun = true;
        } else if (arg === '--skip-secrets') {
            options.skipSecrets = true;
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        }
    }
    
    return options;
}

/**
 * Show help information
 */
function showHelp() {
    console.log(`
Usage: node build-with-secrets.js [options]

Options:
  --env=<environment>     Target environment (dev, pre, prod) [default: dev]
  --dry-run              Preview what would be done without making changes
  --skip-secrets         Skip secrets injection and run standard build
  --help, -h             Show this help message

Examples:
  node build-with-secrets.js --env=dev
  node build-with-secrets.js --env=prod --dry-run
  node build-with-secrets.js --skip-secrets
`);
}

/**
 * Load environment configuration
 */
function loadEnvironment(env) {
    const normalizedEnv = normalizeEnvName(env);
    loadEnvFile(fs, normalizedEnv);
    
    // Set build-specific environment variables
    process.env.BUILD_TIME = new Date().toISOString();
    process.env.BUILD_ENV = normalizedEnv;
    
    return normalizedEnv;
}

/**
 * Execute secrets injection
 */
async function executeSecretsInjection(options) {
    console.log('🔐 Starting secrets injection...');
    
    const orchestrator = new SecretsOrchestrator({
        environment: options.env,
            provider: process.env.SECRETS_PROVIDER || 'infisical',
        providerConfig: {
            // Infisical config
            projectId: process.env.INFISICAL_PROJECT_ID,
            token: process.env.INFISICAL_TOKEN,
            siteURL: process.env.INFISICAL_SITE_URL,
            // Doppler config
            project: process.env.DOPPLER_PROJECT,
            serviceToken: process.env.DOPPLER_TOKEN,
            apiToken: process.env.DOPPLER_API_TOKEN,
            serviceAccountToken: process.env.DOPPLER_SERVICE_ACCOUNT_TOKEN,
            apiKey: process.env.DOPPLER_API_KEY,
            apiHost: process.env.DOPPLER_API_HOST
        },
        validate: true,
        dryRun: options.dryRun,
        cleanup: !options.dryRun
    });
    
    try {
        const result = await orchestrator.executeInjection();
        
        if (!result.success) {
            console.error('❌ Secrets injection failed:', result.error);
            return false;
        }
        
        console.log('✅ Secrets injection completed successfully');
        console.log(`   - Secrets fetched: ${result.secrets.size}`);
        console.log(`   - Files generated: ${result.generatedFiles.length}`);
        console.log(`   - Duration: ${result.duration}`);
        
        if (result.validation) {
            console.log(`   - Validation: ${result.validation.valid ? 'PASSED' : 'FAILED'}`);
        }
        
        return true;
        
    } catch (error) {
        console.error('❌ Critical error during secrets injection:', error.message);
        return false;
    } finally {
        await orchestrator.cleanup();
    }
}

/**
 * Execute standard build process
 */
function executeBuild(options) {
    console.log('🏗️ Starting standard build process...');
    
    try {
        // Execute the build-utils.js script using Node.js instead of Bash
        const buildUtilsScript = path.join(__dirname, 'build-utils.js');
        execSync(`node "${buildUtilsScript}" --env=${options.env}`, {
            stdio: 'inherit',
            cwd: projectRoot
        });
        
        console.log('✅ Build completed successfully');
        return true;
        
    } catch (error) {
        console.error('❌ Build failed:', error.message);
        return false;
    }
}

/**
 * Main execution function
 */
async function main() {
    const options = parseArgs();
    
    if (options.help) {
        showHelp();
        process.exit(0);
    }
    
    console.log('=== Build with Secrets Management ===\n');
    console.log(`Environment: ${options.env}`);
    console.log(`Dry Run: ${options.dryRun}`);
    console.log(`Skip Secrets: ${options.skipSecrets}`);
    console.log('');
    
    try {
        // Load environment configuration
        loadEnvironment(options.env);
        
        let success = true;
        
        // Execute secrets injection unless skipped
        if (!options.skipSecrets) {
            success = await executeSecretsInjection(options);
            
            if (!success && !options.dryRun) {
                console.error('❌ Build aborted due to secrets injection failure');
                process.exit(1);
            }
        }
        
        // Execute standard build process
        if (success && !options.dryRun) {
            success = executeBuild(options);
        }
        
        if (success) {
            console.log('\n🎉 Enhanced build completed successfully!');
            
            if (options.dryRun) {
                console.log('   - Dry run mode - no files were modified');
            } else {
                console.log('   - Secrets injected and validated');
                console.log('   - Worker built and optimized');
            }
        } else {
            console.error('\n❌ Enhanced build failed');
            process.exit(1);
        }
        
    } catch (error) {
        console.error('\n❌ Critical error during build:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

// Execute if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error('Unhandled error:', error);
        process.exit(1);
    });
}

export { parseArgs, executeSecretsInjection, executeBuild };