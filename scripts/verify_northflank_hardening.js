#!/usr/bin/env node

/**
 * NorthFlankRTCache Hardening Verification Script
 * Tests the enhanced Northflank Redis implementation
 */

import { NorthFlankRTCache } from '../src/services/cache/NorthFlankRTCache.js';

// Color codes for output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function logTest(name, passed, details = '') {
    const symbol = passed ? '✓' : '✗';
    const color = passed ? 'green' : 'red';
    log(`${symbol} ${name}`, color);
    if (details) log(`  ${details}`, 'cyan');
}

class NorthFlankHardeningTest {
    constructor() {
        this.results = {
            passed: 0,
            failed: 0,
            tests: []
        };
    }

    async runAllTests() {
        log('\n=== NorthFlankRTCache Hardening Verification ===\n', 'blue');
        
        try {
            await this.testURLParsing();
            await this.testTLSConfiguration();
            await this.testErrorHandling();
            await this.testConnectionInfo();
            await this.testValidation();
            await this.testConfigHardening();
            
            this.printSummary();
            
        } catch (error) {
            log(`\nTest suite failed: ${error.message}`, 'red');
            console.error(error);
            process.exit(1);
        }
    }

    /**
     * Test 1: URL Parsing with various formats
     */
    async testURLParsing() {
        log('\n--- Test 1: URL Parsing ---', 'cyan');
        
        const testCases = [
            {
                name: 'Standard redis:// URL',
                url: 'redis://user:pass@localhost:6379/1',
                shouldPass: true
            },
            {
                name: 'TLS rediss:// URL',
                url: 'rediss://user:pass@localhost:6379/1',
                shouldPass: true
            },
            {
                name: 'URL without password',
                url: 'redis://localhost:6379/0',
                shouldPass: true
            },
            {
                name: 'URL without database',
                url: 'redis://localhost:6379',
                shouldPass: true
            },
            {
                name: 'Invalid URL format',
                url: 'invalid-url',
                shouldPass: false
            },
            {
                name: 'Missing hostname',
                url: 'redis://:6379',
                shouldPass: false
            }
        ];

        for (const testCase of testCases) {
            try {
                const config = NorthFlankRTCache.parseRedisUrlStatic(testCase.url);
                const passed = testCase.shouldPass;
                
                if (passed) {
                    logTest(testCase.name, true, `Host: ${config.host}, Port: ${config.port}, TLS: ${!!config.tls}`);
                    this.recordPass('URL Parsing');
                } else {
                    logTest(testCase.name, false, 'Expected to fail but passed');
                    this.recordFail('URL Parsing');
                }
            } catch (error) {
                const passed = !testCase.shouldPass;
                if (passed) {
                    logTest(testCase.name, true, `Correctly failed: ${error.message}`);
                    this.recordPass('URL Parsing');
                } else {
                    logTest(testCase.name, false, `Unexpected failure: ${error.message}`);
                    this.recordFail('URL Parsing');
                }
            }
        }
    }

    /**
     * Test 2: TLS Configuration
     */
    async testTLSConfiguration() {
        log('\n--- Test 2: TLS Configuration ---', 'cyan');
        
        // Test with redis:// (should still apply TLS for Northflank)
        const config1 = NorthFlankRTCache.parseRedisUrlStatic('redis://localhost:6379');
        const test1Pass = config1.tls && config1.tls.rejectUnauthorized === false;
        logTest('redis:// gets defensive TLS', test1Pass, 
            `TLS enabled: ${!!config1.tls}, rejectUnauthorized: ${config1.tls?.rejectUnauthorized}`);
        
        // Test with rediss:// (should apply TLS)
        const config2 = NorthFlankRTCache.parseRedisUrlStatic('rediss://localhost:6379');
        const test2Pass = config2.tls && config2.tls.rejectUnauthorized === false;
        logTest('rediss:// gets TLS', test2Pass, 
            `TLS enabled: ${!!config2.tls}, rejectUnauthorized: ${config2.tls?.rejectUnauthorized}`);
        
        if (test1Pass && test2Pass) {
            this.recordPass('TLS Configuration');
        } else {
            this.recordFail('TLS Configuration');
        }
    }

    /**
     * Test 3: Error Handling
     */
    async testErrorHandling() {
        log('\n--- Test 3: Error Handling ---', 'cyan');
        
        // Test ECONNREFUSED error reporting
        const mockError = new Error('Connection refused');
        mockError.code = 'ECONNREFUSED';
        
        // Create a mock instance to test _reportError
        try {
            const cache = new NorthFlankRTCache({ host: 'test', port: 6379 });
            
            // Capture console.error output
            const originalError = console.error;
            let errorMessages = [];
            console.error = (...args) => {
                errorMessages.push(args.join(' '));
            };
            
            cache._reportError(mockError);
            
            console.error = originalError;
            
            const hasConnectionRefused = errorMessages.some(msg => msg.includes('ECONNREFUSED'));
            const hasTroubleshooting = errorMessages.some(msg => msg.includes('Troubleshooting steps'));
            
            logTest('ECONNREFUSED handling', hasConnectionRefused && hasTroubleshooting,
                `Has error code: ${hasConnectionRefused}, Has troubleshooting: ${hasTroubleshooting}`);
            
            if (hasConnectionRefused && hasTroubleshooting) {
                this.recordPass('Error Handling');
            } else {
                this.recordFail('Error Handling');
            }
            
        } catch (error) {
            logTest('Error Handling', false, `Failed: ${error.message}`);
            this.recordFail('Error Handling');
        }
    }

    /**
     * Test 4: Connection Info
     */
    async testConnectionInfo() {
        log('\n--- Test 4: Connection Info ---', 'cyan');
        
        try {
            const cache = new NorthFlankRTCache({ host: 'testhost', port: 6380, password: 'secret' });
            const info = cache.getConnectionInfo();
            
            const hasRequiredFields = info.provider && info.host && info.port !== undefined;
            const hasNorthflankFields = info.connectTimeout && info.maxRetriesPerRequest;
            const hasMaskedUrl = info.urlMasked && !info.urlMasked.includes('secret');
            
            logTest('Connection info structure', hasRequiredFields && hasNorthflankFields,
                `Provider: ${info.provider}, Timeout: ${info.connectTimeout}`);
            
            logTest('URL masking', hasMaskedUrl,
                `Masked URL: ${info.urlMasked}`);
            
            if (hasRequiredFields && hasNorthflankFields && hasMaskedUrl) {
                this.recordPass('Connection Info');
            } else {
                this.recordFail('Connection Info');
            }
            
        } catch (error) {
            logTest('Connection Info', false, `Failed: ${error.message}`);
            this.recordFail('Connection Info');
        }
    }

    /**
     * Test 5: Configuration Validation
     */
    async testValidation() {
        log('\n--- Test 5: Configuration Validation ---', 'cyan');
        
        // Test valid config
        try {
            const cache1 = new NorthFlankRTCache({ host: 'test', port: 6379 });
            const validation1 = cache1.validateConnectionConfig();
            
            logTest('Valid config validation', validation1.isValid,
                `Errors: ${validation1.errors.length}, Warnings: ${validation1.warnings.length}`);
            
            if (validation1.isValid) {
                this.recordPass('Configuration Validation');
            } else {
                this.recordFail('Configuration Validation');
            }
            
        } catch (error) {
            logTest('Valid config validation', false, `Failed: ${error.message}`);
            this.recordFail('Configuration Validation');
        }
        
        // Test invalid config - need to provide host/port to avoid env lookup
        try {
            // First create a valid instance to get the validateConnectionConfig method
            const cache2 = new NorthFlankRTCache({ host: 'test', port: 6379 });
            
            // Manually set invalid config for testing
            cache2.config.host = '';
            cache2.config.port = 0;
            
            const validation2 = cache2.validateConnectionConfig();
            
            const hasErrors = validation2.errors.length > 0;
            logTest('Invalid config detection', hasErrors,
                `Errors detected: ${validation2.errors.length}`);
            
            if (hasErrors) {
                this.recordPass('Invalid Config Detection');
            } else {
                this.recordFail('Invalid Config Detection');
            }
            
        } catch (error) {
            logTest('Invalid config detection', false, `Failed: ${error.message}`);
            this.recordFail('Invalid Config Detection');
        }
    }

    /**
     * Test 6: Config Hardening
     */
    async testConfigHardening() {
        log('\n--- Test 6: Config Hardening ---', 'cyan');
        
        // Test that constructor applies hardening
        try {
            const cache = new NorthFlankRTCache({ host: 'test', port: 6379 });
            
            // Check if hardening options are applied
            const hasConnectTimeout = cache.config.connectTimeout === 10000;
            const hasCommandTimeout = cache.config.commandTimeout === 5000;
            const hasMaxRetries = cache.config.maxRetriesPerRequest === 1;
            const hasRetryStrategy = typeof cache.config.retryStrategy === 'function';
            const hasTLS = cache.config.tls && cache.config.tls.rejectUnauthorized === false;
            
            logTest('Connect timeout applied', hasConnectTimeout, `Value: ${cache.config.connectTimeout}`);
            logTest('Command timeout applied', hasCommandTimeout, `Value: ${cache.config.commandTimeout}`);
            logTest('Max retries applied', hasMaxRetries, `Value: ${cache.config.maxRetriesPerRequest}`);
            logTest('Retry strategy applied', hasRetryStrategy);
            logTest('TLS hardening applied', hasTLS);
            
            const allPassed = hasConnectTimeout && hasCommandTimeout && hasMaxRetries && hasRetryStrategy && hasTLS;
            
            if (allPassed) {
                this.recordPass('Config Hardening');
            } else {
                this.recordFail('Config Hardening');
            }
            
        } catch (error) {
            logTest('Config Hardening', false, `Failed: ${error.message}`);
            this.recordFail('Config Hardening');
        }
    }

    /**
     * Record test results
     */
    recordPass(testName) {
        this.results.passed++;
        this.results.tests.push({ name: testName, passed: true });
    }

    recordFail(testName) {
        this.results.failed++;
        this.results.tests.push({ name: testName, passed: false });
    }

    /**
     * Print summary
     */
    printSummary() {
        log('\n=== Test Summary ===', 'blue');
        
        const total = this.results.passed + this.results.failed;
        const percentage = total > 0 ? Math.round((this.results.passed / total) * 100) : 0;
        
        log(`Total Tests: ${total}`);
        log(`Passed: ${this.results.passed}`, 'green');
        log(`Failed: ${this.results.failed}`, this.results.failed > 0 ? 'red' : 'green');
        log(`Success Rate: ${percentage}%`, percentage === 100 ? 'green' : 'yellow');
        
        if (this.results.failed > 0) {
            log('\nFailed Tests:', 'red');
            this.results.tests
                .filter(t => !t.passed)
                .forEach(t => log(`  - ${t.name}`, 'red'));
        }
        
        log('\n=== NorthFlankRTCache Hardening Complete ===', percentage === 100 ? 'green' : 'yellow');
        
        if (percentage === 100) {
            log('✓ All hardening tests passed!', 'green');
        } else {
            log('✗ Some tests failed. Please review the implementation.', 'red');
            process.exit(1);
        }
    }
}

// Run tests
const tester = new NorthFlankHardeningTest();
tester.runAllTests().catch(error => {
    log(`\nFatal error: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
});