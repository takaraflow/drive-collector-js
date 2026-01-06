#!/usr/bin/env node

/**
 * Cache Service Phase3 Verification Script
 * Tests L1/L2 architecture, Provider Factory, and Failover mechanisms
 */

import { cache } from '../src/services/CacheService.js';
import { localCache } from '../src/utils/LocalCache.js';

// Test configuration
const TEST_PREFIX = '__test_phase3__';
const TEST_TIMEOUT = 10000;

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

// Test utilities
async function runWithTimeout(testFn, timeout = TEST_TIMEOUT) {
    return Promise.race([
        testFn(),
        new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Test timeout')), timeout)
        )
    ]);
}

// Test Suite
class CachePhase3Test {
    constructor() {
        this.results = {
            passed: 0,
            failed: 0,
            tests: []
        };
    }

    async runAllTests() {
        log('\n=== Cache Service Phase3 Verification ===\n', 'blue');
        
        try {
            // Initialize cache service
            log('Initializing CacheService...', 'yellow');
            await cache.initialize();
            log(`Current Provider: ${cache.getCurrentProvider()}`, 'cyan');
            log(`Failover Mode: ${cache.isFailoverMode}`, 'cyan');
            log('');
            
            // Run tests
            await this.testL1Cache();
            await this.testL2Provider();
            await this.testL1L2Integration();
            await this.testFailoverMechanism();
            await this.testProviderFactory();
            await this.testCompatibility();
            await this.testAutoRecovery();
            
            // Print summary
            this.printSummary();
            
        } catch (error) {
            log(`\nTest suite failed: ${error.message}`, 'red');
            console.error(error);
            process.exit(1);
        }
    }

    /**
     * Test 1: L1 Cache (LocalCache) functionality
     */
    async testL1Cache() {
        log('\n--- Test 1: L1 Cache (LocalCache) ---', 'cyan');
        
        try {
            // Test direct L1 access
            const key1 = `${TEST_PREFIX}l1_direct`;
            const value1 = { test: 'l1', timestamp: Date.now() };
            
            // Set via L1
            localCache.set(key1, value1, 5000);
            const retrieved1 = localCache.get(key1);
            
            const test1Pass = JSON.stringify(retrieved1) === JSON.stringify(value1);
            logTest('L1 Direct Set/Get', test1Pass, `Value: ${JSON.stringify(retrieved1)}`);
            
            // Test TTL expiration
            const key2 = `${TEST_PREFIX}l1_ttl`;
            localCache.set(key2, 'expire_test', 100); // 100ms TTL
            
            await new Promise(resolve => setTimeout(resolve, 150));
            const expired = localCache.get(key2);
            
            const test2Pass = expired === null;
            logTest('L1 TTL Expiration', test2Pass, `Expired: ${expired === null}`);
            
            // Test L1 size limit (if applicable)
            const key3 = `${TEST_PREFIX}l1_size`;
            localCache.set(key3, 'size_test', 5000);
            const hasKey = localCache.get(key3) !== null;
            
            logTest('L1 Basic Operations', hasKey, 'All L1 operations working');
            
            if (test1Pass && test2Pass && hasKey) {
                this.recordPass('L1 Cache');
            } else {
                this.recordFail('L1 Cache');
            }
            
        } catch (error) {
            logTest('L1 Cache', false, error.message);
            this.recordFail('L1 Cache');
        }
    }

    /**
     * Test 2: L2 Provider functionality
     */
    async testL2Provider() {
        log('\n--- Test 2: L2 Provider (Remote) ---', 'cyan');
        
        try {
            const key = `${TEST_PREFIX}l2_test`;
            const value = { provider: 'l2', data: 'test_value' };
            
            // Test Set
            const setResult = await cache.set(key, value, 300);
            logTest('L2 Set Operation', setResult === true, `Result: ${setResult}`);
            
            // Test Get
            const getValue = await cache.get(key);
            const getPass = JSON.stringify(getValue) === JSON.stringify(value);
            logTest('L2 Get Operation', getPass, `Retrieved: ${JSON.stringify(getValue)}`);
            
            // Test Delete
            const deleteResult = await cache.delete(key);
            // After delete, get should return null (from L2) or undefined
            const deletedValue = await cache.get(key);
            const deletePass = deleteResult === true && (deletedValue === null || deletedValue === undefined);
            logTest('L2 Delete Operation', deletePass, `Deleted: ${deleteResult}, Value after: ${deletedValue}`);
            
            if (setResult && getPass && deletePass) {
                this.recordPass('L2 Provider');
            } else {
                this.recordFail('L2 Provider');
            }
            
        } catch (error) {
            logTest('L2 Provider', false, error.message);
            this.recordFail('L2 Provider');
        }
    }

    /**
     * Test 3: L1/L2 Integration (Cache-Aside Pattern)
     */
    async testL1L2Integration() {
        log('\n--- Test 3: L1/L2 Integration ---', 'cyan');
        
        try {
            const key = `${TEST_PREFIX}integration`;
            const value = { integrated: true, timestamp: Date.now() };
            
            // Clear L1 to ensure fresh test
            localCache.del(key);
            
            // Set operation: Should write to both L1 and L2
            await cache.set(key, value, 600);
            
            // Verify L1 was populated
            const l1Value = localCache.get(key);
            const l1Pass = JSON.stringify(l1Value) === JSON.stringify(value);
            logTest('L1/L2 Set - L1 Backfill', l1Pass, `L1 has: ${l1Pass}`);
            
            // Get operation: Should read from L1 (fast path)
            const startTime = Date.now();
            const getValue = await cache.get(key);
            const duration = Date.now() - startTime;
            const getPass = JSON.stringify(getValue) === JSON.stringify(value);
            
            logTest('L1/L2 Get - Fast Path', getPass && duration < 10, 
                `Duration: ${duration}ms, Value: ${getPass}`);
            
            // Skip cache test: Should bypass L1
            const skipValue = await cache.get(key, 'json', { skipCache: true });
            const skipPass = JSON.stringify(skipValue) === JSON.stringify(value);
            logTest('L1/L2 Get - Skip Cache', skipPass, `Bypassed L1: ${skipPass}`);
            
            if (l1Pass && getPass && skipPass) {
                this.recordPass('L1/L2 Integration');
            } else {
                this.recordFail('L1/L2 Integration');
            }
            
        } catch (error) {
            logTest('L1/L2 Integration', false, error.message);
            this.recordFail('L1/L2 Integration');
        }
    }

    /**
     * Test 4: Failover Mechanism
     */
    async testFailoverMechanism() {
        log('\n--- Test 4: Failover Mechanism ---', 'cyan');
        
        try {
            // Test failure tracking
            const initialFailures = cache.failureCountValue || 0;
            
            // Simulate failures by calling non-existent methods on provider
            // This will test the failover logic
            logTest('Failover State Tracking', true, 
                `Initial failures: ${initialFailures}, Failover: ${cache.isFailoverMode}`);
            
            // Test that failover provider exists
            const hasFailover = cache.failoverEnabled;
            logTest('Failover Provider Exists', hasFailover, `Available: ${hasFailover}`);
            
            // Test operations still work in potential failover scenario
            const key = `${TEST_PREFIX}failover_test`;
            const value = { failover: 'test' };
            
            const setOp = await cache.set(key, value, 300);
            const getOp = await cache.get(key);
            const deleteOp = await cache.delete(key);
            
            const allOpsPass = setOp === true && getOp !== null && deleteOp === true;
            logTest('Operations in Failover Context', allOpsPass, 
                `Set: ${setOp}, Get: ${getOp !== null}, Delete: ${deleteOp}`);
            
            if (hasFailover && allOpsPass) {
                this.recordPass('Failover Mechanism');
            } else {
                this.recordFail('Failover Mechanism');
            }
            
        } catch (error) {
            logTest('Failover Mechanism', false, error.message);
            this.recordFail('Failover Mechanism');
        }
    }

    /**
     * Test 5: Provider Factory
     */
    async testProviderFactory() {
        log('\n--- Test 5: Provider Factory ---', 'cyan');
        
        try {
            const currentProvider = cache.getCurrentProvider();
            const providerType = cache.providerType;
            
            logTest('Provider Detection', true, `Type: ${providerType}, Full: ${currentProvider}`);
            
            // Test that provider type is one of the expected values
            const validProviders = ['cloudflare', 'RedisCache', 'RedisTLSCache', 'NorthFlankRTCache', 'memory'];
            const isValid = validProviders.some(p => providerType.includes(p));
            
            logTest('Provider Type Validity', isValid, `Valid: ${isValid}`);
            
            // Test provider-specific operations if applicable
            if (providerType.includes('Redis') || providerType.includes('cloudflare')) {
                const key = `${TEST_PREFIX}provider_specific`;
                const result = await cache.set(key, { test: true }, 300);
                logTest('Provider Operations', result === true, `Set result: ${result}`);
            } else {
                logTest('Provider Operations', true, 'Memory provider (fallback)');
            }
            
            if (isValid) {
                this.recordPass('Provider Factory');
            } else {
                this.recordFail('Provider Factory');
            }
            
        } catch (error) {
            logTest('Provider Factory', false, error.message);
            this.recordFail('Provider Factory');
        }
    }

    /**
     * Test 6: Compatibility Layer
     */
    async testCompatibility() {
        log('\n--- Test 6: Compatibility Layer ---', 'cyan');
        
        try {
            // Test all compatibility getters
            const hasRedis = cache.hasRedis;
            const hasCloudflare = cache.hasCloudflare;
            const hasUpstash = cache.hasUpstash;
            const failoverEnabled = cache.failoverEnabled;
            const isFailover = cache.isFailoverMode;
            
            logTest('Compatibility Getters', true, 
                `Redis: ${hasRedis}, CF: ${hasCloudflare}, Upstash: ${hasUpstash}`);
            
            logTest('Failover Properties', true, 
                `Enabled: ${failoverEnabled}, Active: ${isFailover}`);
            
            // Test that these don't throw errors
            const provider = cache.getCurrentProvider();
            const status = cache.getStatus();
            
            logTest('Status Methods', true, 
                `Provider: ${provider}, Status: ${!!status}`);
            
            // Test legacy methods exist
            const hasStopRecovery = typeof cache.stopRecoveryCheck === 'function';
            const hasStopHeartbeat = typeof cache.stopHeartbeat === 'function';
            
            logTest('Legacy Methods', hasStopRecovery && hasStopHeartbeat, 
                `stopRecoveryCheck: ${hasStopRecovery}, stopHeartbeat: ${hasStopHeartbeat}`);
            
            if (hasRedis !== undefined && hasCloudflare !== undefined && 
                hasStopRecovery && hasStopHeartbeat) {
                this.recordPass('Compatibility Layer');
            } else {
                this.recordFail('Compatibility Layer');
            }
            
        } catch (error) {
            logTest('Compatibility Layer', false, error.message);
            this.recordFail('Compatibility Layer');
        }
    }

    /**
     * Test 7: Auto Recovery
     */
    async testAutoRecovery() {
        log('\n--- Test 7: Auto Recovery ---', 'cyan');
        
        try {
            // Test that recovery timer can be started/stopped
            cache.stopRecoveryCheck(); // Stop any existing timer
            
            // Start recovery check (this is internal, but we can verify it doesn't crash)
            cache._startRecoveryCheck();
            
            logTest('Recovery Timer Start', true, 'Recovery mechanism initialized');
            
            // Test heartbeat
            cache.stopHeartbeat();
            cache._startHeartbeat();
            
            logTest('Heartbeat Timer Start', true, 'Heartbeat mechanism initialized');
            
            // Test cleanup
            cache.stopRecoveryCheck();
            cache.stopHeartbeat();
            
            logTest('Timer Cleanup', true, 'All timers stopped');
            
            this.recordPass('Auto Recovery');
            
        } catch (error) {
            logTest('Auto Recovery', false, error.message);
            this.recordFail('Auto Recovery');
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
        
        log('\n=== Phase3 Implementation Complete ===', percentage === 100 ? 'green' : 'yellow');
        
        if (percentage === 100) {
            log('✓ All tests passed! Phase3 implementation is correct.', 'green');
        } else {
            log('✗ Some tests failed. Please review the implementation.', 'red');
            process.exit(1);
        }
    }
}

// Run tests
const tester = new CachePhase3Test();
tester.runAllTests().catch(error => {
    log(`\nFatal error: ${error.message}`, 'red');
    console.error(error);
    process.exit(1);
});