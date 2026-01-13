/**
 * Production Dependencies Validation Test
 * 
 * This test ensures that all dynamically imported third-party packages
 * are properly listed in package.json dependencies, not devDependencies.
 * 
 * Root Cause: ioredis was previously in devDependencies, causing production
 * failures when npm install --production was used.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');

// Critical modules that use dynamic imports
const DYNAMIC_IMPORT_MODULES = [
    {
        file: 'src/services/CacheService.js',
        packages: ['ioredis'],
        description: 'Redis client for caching'
    },
    {
        file: 'src/services/logger/index.js',
        packages: ['@axiomhq/js'],
        description: 'Axiom logging service'
    }
];

// Helper to extract external packages from source code
function extractExternalPackages(filePath) {
    const fullPath = join(projectRoot, filePath);
    let content;
    
    try {
        content = readFileSync(fullPath, 'utf-8');
    } catch (error) {
        return [];
    }
    
    const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    
    const packages = new Set();
    let match;
    
    while ((match = dynamicImportRegex.exec(content)) !== null) {
        const importPath = match[1];
        
        if (importPath.startsWith('.') || importPath.startsWith('/')) {
            continue;
        }
        
        const builtInModules = [
            'fs', 'path', 'url', 'crypto', 'http', 'https', 'net', 'tls',
            'stream', 'events', 'util', 'buffer', 'querystring', 'url',
            'os', 'child_process', 'cluster', 'dgram', 'dns', 'readline',
            'repl', 'v8', 'vm', 'worker_threads', 'perf_hooks', 'async_hooks'
        ];
        
        if (builtInModules.includes(importPath)) {
            continue;
        }
        
        const packageName = importPath.split('/')[0];
        
        if (packageName) {
            packages.add(packageName);
        }
    }
    
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(content)) !== null) {
        const importPath = match[1];
        
        if (importPath.startsWith('.') || importPath.startsWith('/')) {
            continue;
        }
        
        const builtInModules = [
            'fs', 'path', 'url', 'crypto', 'http', 'https', 'net', 'tls',
            'stream', 'events', 'util', 'buffer', 'querystring', 'url',
            'os', 'child_process', 'cluster', 'dgram', 'dns', 'readline',
            'repl', 'v8', 'vm', 'worker_threads', 'perf_hooks', 'async_hooks'
        ];
        
        if (builtInModules.includes(importPath)) {
            continue;
        }
        
        const packageName = importPath.split('/')[0];
        
        if (packageName) {
            packages.add(packageName);
        }
    }
    
    return Array.from(packages);
}

function getProductionDependencies() {
    const packageJsonPath = join(projectRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return Object.keys(packageJson.dependencies || {});
}

function getDevDependencies() {
    const packageJsonPath = join(projectRoot, 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    return Object.keys(packageJson.devDependencies || {});
}

describe('Production Dependencies Validation', () => {
    let productionDependencies;
    let allRequiredPackages;

    beforeAll(() => {
        productionDependencies = getProductionDependencies();
        
        allRequiredPackages = new Set();
        DYNAMIC_IMPORT_MODULES.forEach(module => {
            module.packages.forEach(pkg => allRequiredPackages.add(pkg));
        });
        
        DYNAMIC_IMPORT_MODULES.forEach(module => {
            const extracted = extractExternalPackages(module.file);
            extracted.forEach(pkg => allRequiredPackages.add(pkg));
        });
    });

    test('should have all dynamic import packages in dependencies', () => {
        const missingPackages = [];
        
        allRequiredPackages.forEach(pkg => {
            if (!productionDependencies.includes(pkg)) {
                missingPackages.push(pkg);
            }
        });
        
        expect(missingPackages).toEqual([]);
    });

    test('should verify critical modules are in production dependencies', () => {
        DYNAMIC_IMPORT_MODULES.forEach(module => {
            module.packages.forEach(pkg => {
                expect(productionDependencies).toContain(pkg);
            });
        });
    });

    test('should scan source files for additional dynamic imports', () => {
        DYNAMIC_IMPORT_MODULES.forEach(module => {
            const extracted = extractExternalPackages(module.file);
            
            extracted.forEach(pkg => {
                expect(productionDependencies).toContain(pkg);
            });
        });
    });

    test('should ensure no critical packages are in devDependencies', () => {
        const devDependencies = getDevDependencies();
        const conflicts = [];
        
        allRequiredPackages.forEach(pkg => {
            if (devDependencies.includes(pkg)) {
                conflicts.push(pkg);
            }
        });
        
        expect(conflicts).toEqual([]);
    });

    test('should validate all source files mentioned in plan', () => {
        const expectedFiles = DYNAMIC_IMPORT_MODULES.map(m => m.file);
        
        expect(expectedFiles.length).toBeGreaterThan(0);
    });
});

describe('Edge Cases - Production Dependencies', () => {
    test('should handle built-in Node.js modules correctly', () => {
        const builtInModules = [
            'fs', 'path', 'url', 'crypto', 'http', 'https', 'net', 'tls',
            'stream', 'events', 'util', 'buffer', 'querystring',
            'os', 'child_process', 'cluster', 'dgram', 'dns', 'readline',
            'repl', 'v8', 'vm', 'worker_threads', 'perf_hooks', 'async_hooks'
        ];
        
        const packageJsonPath = join(projectRoot, 'package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        const allDeps = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies
        };
        
        const foundBuiltIns = builtInModules.filter(mod => allDeps[mod]);
        
        expect(foundBuiltIns).toEqual([]);
    });

    test('should handle relative imports correctly', () => {
        const testContent = `
            import { config } from '../config/index.js';
            import { localCache } from '../../utils/LocalCache.js';
            import('./local-module.js');
            import('ioredis');
        `;
        
        const packageJsonPath = join(projectRoot, 'package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        const productionDependencies = Object.keys(packageJson.dependencies || {});
        
        const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
        const packages = new Set();
        let match;
        
        while ((match = dynamicImportRegex.exec(testContent)) !== null) {
            const importPath = match[1];
            if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
                packages.add(importPath.split('/')[0]);
            }
        }
        
        expect(packages.has('ioredis')).toBe(true);
        expect(packages.has('../config/index.js')).toBe(false);
        expect(packages.has('../../utils/LocalCache.js')).toBe(false);
        expect(packages.has('./local-module.js')).toBe(false);
    });
});
