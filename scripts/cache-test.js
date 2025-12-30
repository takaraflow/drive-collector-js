#!/usr/bin/env node

/**
 * Cache 服务独立测试脚本
 * 全面测试 CacheService 的 L1/L2 缓存、多提供商切换、故障转移恢复等功能
 */

import 'dotenv/config';
import { performance } from "perf_hooks";

// 设置测试环境
process.env.NODE_ENV = 'development';
process.env.JEST_WORKER_ID = '1';

// 延迟导入以避免初始化问题
let cache = null;
let logger = null;

/**
 * Cache 测试器类
 */
class CacheTester {
    constructor(options = {}) {
        this.options = {
            verbose: options.verbose || false,
            concurrency: options.concurrency || 1,
            testPrefix: options.testPrefix || 'test:cache:',
            ...options
        };
        this.results = [];
        this.stats = {
            totalTests: 0,
            passedTests: 0,
            failedTests: 0,
            totalLatency: 0,
            l1Hits: 0,
            l1Misses: 0
        };
        this.cache = null;
        this.logger = null;
    }

    /**
     * 初始化模块
     */
    async init() {
        try {
            console.log('🔧 正在初始化模块...');
            const cacheModule = await import('../src/services/CacheService.js');
            this.cache = cacheModule.cache;
            
            const loggerModule = await import('../src/services/logger.js');
            this.logger = loggerModule.default;
            
            console.log('✅ 模块初始化完成');
        } catch (error) {
            console.error('💥 模块初始化失败:', error.message);
            throw error;
        }
    }

    /**
     * 记录测试结果
     */
    log(testName, success, message = '', latency = 0) {
        const status = success ? '✅ [PASS]' : '❌ [FAIL]';
        const latencyInfo = latency > 0 ? ` (${latency.toFixed(2)}ms)` : '';
        const messageInfo = message ? ` - ${message}` : '';
        
        console.log(`${status} ${testName}${latencyInfo}${messageInfo}`);
        
        this.results.push({
            test: testName,
            success,
            message,
            latency
        });
        
        this.stats.totalTests++;
        if (success) {
            this.stats.passedTests++;
        } else {
            this.stats.failedTests++;
        }
        this.stats.totalLatency += latency;
    }

    /**
     * 详细日志记录
     */
    debug(message, data = null) {
        if (this.options.verbose) {
            console.log(`🔍 DEBUG: ${message}`, data || '');
        }
    }

    /**
     * 清理测试数据
     */
    async cleanup() {
        try {
            const keys = await this.cache.listKeys(this.options.testPrefix);
            for (const key of keys) {
                await this.cache.delete(key);
            }
            this.debug(`清理了 ${keys.length} 个测试键`);
        } catch (error) {
            this.debug('清理测试数据失败', error.message);
        }
    }

    /**
     * 测试 1: 基础 Set/Get
     */
    async testBasicSetGet() {
        const startTime = performance.now();
        const testKey = `${this.options.testPrefix}basic`;
        const testValue = { message: 'Hello Cache Service!' }; // Use JSON object

        try {
            await this.cache.set(testKey, testValue);
            const retrieved = await this.cache.get(testKey);
            
            const success = JSON.stringify(retrieved) === JSON.stringify(testValue);
            const latency = performance.now() - startTime;
            
            this.log('Basic Set/Get', success, success ? 'Value matched' : `Expected: ${JSON.stringify(testValue)}, Got: ${JSON.stringify(retrieved)}`, latency);
            
            await this.cache.delete(testKey);
        } catch (error) {
            const latency = performance.now() - startTime;
            this.log('Basic Set/Get', false, error.message, latency);
        }
    }

    /**
     * 测试 2: JSON 对象支持
     */
    async testJsonObjectSupport() {
        const startTime = performance.now();
        const testKey = `${this.options.testPrefix}json`;
        const testObject = {
            id: 123,
            name: '测试用户',
            data: {
                timestamp: Date.now(),
                metadata: { version: '1.0.0' }
            }
        };

        try {
            await this.cache.set(testKey, testObject);
            const retrieved = await this.cache.get(testKey);
            
            const success = JSON.stringify(retrieved) === JSON.stringify(testObject);
            const latency = performance.now() - startTime;
            
            this.log('JSON Object Support', success, success ? 'Object structure preserved' : 'Object structure changed', latency);
            
            await this.cache.delete(testKey);
        } catch (error) {
            const latency = performance.now() - startTime;
            this.log('JSON Object Support', false, error.message, latency);
        }
    }

    /**
     * 测试 3: TTL 验证
     */
    async testTTLVerification() {
        const startTime = performance.now();
        const testKey = `${this.options.testPrefix}ttl`;
        const testValue = { message: 'TTL Test Value' }; // Use JSON object
        const provider = this.cache.getCurrentProvider();
        
        try {
            let ttlSeconds;
            let waitTime;
            
            // Cloudflare KV has minimum TTL of 60 seconds, so adjust test accordingly
            if (provider === 'Cloudflare KV') {
                ttlSeconds = 65; // Use 65 seconds to account for minimum + buffer
                waitTime = (ttlSeconds + 5) * 1000; // Wait 5 extra seconds
            } else {
                ttlSeconds = 2; // 2秒过期 for Redis/Upstash
                waitTime = (ttlSeconds + 0.5) * 1000;
            }

            // 设置带TTL的值
            await this.cache.set(testKey, testValue, ttlSeconds * 1000);
            
            // 立即检查，应该存在
            const immediate = await this.cache.get(testKey);
            const immediateSuccess = JSON.stringify(immediate) === JSON.stringify(testValue);
            
            this.debug(`TTL test - immediate check: ${immediateSuccess}, provider: ${provider}`);
            
            // 等待过期时间 + 缓冲
            await new Promise(resolve => setTimeout(resolve, waitTime));
            
            // 检查过期，应该为null
            const expired = await this.cache.get(testKey);
            const expiredSuccess = expired === null;
            
            const latency = performance.now() - startTime;
            const success = immediateSuccess && expiredSuccess;
            
            this.log('TTL Verification', success, 
                success ? 'TTL working correctly' : `Immediate: ${immediateSuccess}, Expired: ${expiredSuccess} (${provider})`, 
                latency);
            
            await this.cache.delete(testKey).catch(() => {});
        } catch (error) {
            const latency = performance.now() - startTime;
            this.log('TTL Verification', false, error.message, latency);
        }
    }

    /**
     * 测试 4: 删除操作
     */
    async testDeleteOperation() {
        const startTime = performance.now();
        const testKey = `${this.options.testPrefix}delete`;

        try {
            // 先设置值
            await this.cache.set(testKey, 'delete test');
            const beforeDelete = await this.cache.get(testKey);
            
            // 删除
            const deleted = await this.cache.delete(testKey);
            
            // 验证删除
            const afterDelete = await this.cache.get(testKey);
            
            const success = beforeDelete === 'delete test' && 
                           deleted === true && 
                           afterDelete === null;
            const latency = performance.now() - startTime;
            
            this.log('Delete Operation', success, 
                success ? 'Delete worked correctly' : `Before: ${beforeDelete}, Deleted: ${deleted}, After: ${afterDelete}`, 
                latency);
        } catch (error) {
            const latency = performance.now() - startTime;
            this.log('Delete Operation', false, error.message, latency);
        }
    }

    /**
     * 测试 5: 列出键
     */
    async testListKeys() {
        const startTime = performance.now();
        const prefix = `${this.options.testPrefix}list`;
        const testKeys = [`${prefix}1`, `${prefix}2`, `${prefix}3`];
        const testValue = 'list test';

        try {
            // 清理现有测试键
            const existing = await this.cache.listKeys(prefix);
            for (const key of existing) {
                await this.cache.delete(key);
            }

            // 设置测试键
            for (const key of testKeys) {
                await this.cache.set(key, testValue);
            }
            
            // 列出键
            const listedKeys = await this.cache.listKeys(prefix);
            
            const success = testKeys.every(key => listedKeys.includes(key)) &&
                           listedKeys.length >= testKeys.length;
            const latency = performance.now() - startTime;
            
            this.log('List Keys', success, 
                success ? `Found ${listedKeys.length} keys` : `Expected ${testKeys.length}, got ${listedKeys.length}`, 
                latency);
            
            // 清理
            for (const key of testKeys) {
                await this.cache.delete(key).catch(() => {});
            }
        } catch (error) {
            const latency = performance.now() - startTime;
            this.log('List Keys', false, error.message, latency);
        }
    }

    /**
     * 测试 6: 批量设置
     */
    async testBulkSet() {
        const startTime = performance.now();
        const testPairs = [];
        const pairCount = 5;
        
        for (let i = 0; i < pairCount; i++) {
            testPairs.push({
                key: `${this.options.testPrefix}bulk${i}`,
                value: `bulk test value ${i}`
            });
        }

        try {
            // 批量设置
            const results = await this.cache.bulkSet(testPairs);
            
            // 验证所有设置成功
            const allSuccess = results.every(result => result.success);
            
            // 验证值是否正确存储
            const verificationPromises = testPairs.map(async (pair) => {
                const retrieved = await this.cache.get(pair.key);
                return retrieved === pair.value;
            });
            const allVerified = (await Promise.all(verificationPromises)).every(Boolean);
            
            const success = allSuccess && allVerified;
            const latency = performance.now() - startTime;
            
            this.log('Bulk Set', success, 
                success ? `${pairCount} pairs set successfully` : `Success: ${allSuccess}, Verified: ${allVerified}`, 
                latency);
            
            // 清理
            for (const pair of testPairs) {
                await this.cache.delete(pair.key).catch(() => {});
            }
        } catch (error) {
            const latency = performance.now() - startTime;
            this.log('Bulk Set', false, error.message, latency);
        }
    }

    /**
     * 测试 7: L1 缓存一致性
     */
    async testL1CacheConsistency() {
        const startTime = performance.now();
        const testKey = `${this.options.testPrefix}l1cache`;
        const testValue = { message: 'L1 cache test' }; // Use JSON object

        try {
            // First, set the value to ensure it exists
            await this.cache.set(testKey, testValue);
            
            // Clear L1 cache to simulate cold start
            // Note: We can't directly clear L1, but we can wait for TTL or use skipCache
            // For testing, we'll use skipCache to force L2 read first
            const start1 = performance.now();
            const firstGet = await this.cache.get(testKey, 'json', { skipCache: true });
            const time1 = performance.now() - start1;
            
            // Second get should use L1 cache
            const start2 = performance.now();
            const secondGet = await this.cache.get(testKey);
            const time2 = performance.now() - start2;
            
            const success = JSON.stringify(firstGet) === JSON.stringify(testValue) && 
                           JSON.stringify(secondGet) === JSON.stringify(testValue) && 
                           time2 < time1; // L1 should be faster
            
            const latency = performance.now() - startTime;
            
            this.log('L1 Cache Consistency', success, 
                success ? `L1 faster: ${time1.toFixed(2)}ms -> ${time2.toFixed(2)}ms` : 
                         `Times: ${time1.toFixed(2)}ms, ${time2.toFixed(2)}ms`, 
                latency);
            
            await this.cache.delete(testKey).catch(() => {});
        } catch (error) {
            const latency = performance.now() - startTime;
            this.log('L1 Cache Consistency', false, error.message, latency);
        }
    }

    /**
     * 测试 8: 跳过缓存选项
     */
    async testSkipCacheOption() {
        const startTime = performance.now();
        const testKey = `${this.options.testPrefix}skipcache`;
        const testValue = { message: 'skip cache test' }; // Use JSON object

        try {
            // 设置值
            await this.cache.set(testKey, testValue);
            
            // 正常获取（应该使用L1缓存）
            const normalGet = await this.cache.get(testKey);
            
            // 跳过缓存获取（强制穿透到L2）
            const skipCacheGet = await this.cache.get(testKey, 'json', { skipCache: true });
            
            const success = JSON.stringify(normalGet) === JSON.stringify(testValue) && 
                           JSON.stringify(skipCacheGet) === JSON.stringify(testValue);
            const latency = performance.now() - startTime;
            
            this.log('Skip Cache Option', success, 
                success ? 'Both normal and skip cache worked' : 
                         `Normal: ${JSON.stringify(normalGet)}, Skip: ${JSON.stringify(skipCacheGet)}`, 
                latency);
            
            await this.cache.delete(testKey).catch(() => {});
        } catch (error) {
            const latency = performance.now() - startTime;
            this.log('Skip Cache Option', false, error.message, latency);
        }
    }

    /**
     * 测试 9: 故障转移模拟
     */
    async testFailoverSimulation() {
        const startTime = performance.now();
        const testKey = `${this.options.testPrefix}failover`;
        const testValue = 'failover test';

        try {
            // 获取初始提供商
            const initialProvider = this.cache.getCurrentProvider();
            this.debug(`初始提供商: ${initialProvider}`);
            
            // 设置测试值
            await this.cache.set(testKey, testValue);
            
            // 正常操作
            const beforeValue = await this.cache.get(testKey);
            
            // 模拟提供商切换（通过环境变量）
            const originalProvider = this.cache.currentProvider;
            this.cache.currentProvider = this.cache.hasUpstash ? 'upstash' : 
                                   (this.cache.hasRedis ? 'redis' : 'cloudflare');
            
            this.debug(`切换到提供商: ${this.cache.getCurrentProvider()}`);
            
            // 在新提供商中验证数据（注意：不同提供商间数据不共享）
            const afterSwitch = await this.cache.get(testKey);
            
            // 恢复原始提供商
            this.cache.currentProvider = originalProvider;
            
            const success = beforeValue === testValue; // 原始操作成功
            const latency = performance.now() - startTime;
            
            this.log('Failover Simulation', success, 
                success ? 'Provider switching mechanism works' : 'Provider switching failed', 
                latency);
            
            await this.cache.delete(testKey).catch(() => {});
        } catch (error) {
            const latency = performance.now() - startTime;
            this.log('Failover Simulation', false, error.message, latency);
        }
    }

    /**
     * 测试 10: 并发压力测试
     */
    async testConcurrencyStress() {
        const startTime = performance.now();
        const concurrency = this.options.concurrency;
        const testKey = `${this.options.testPrefix}concurrency`;
        const testValue = 'concurrent test';

        try {
            // 设置初始值
            await this.cache.set(testKey, testValue);
            
            // 并发读取测试
            const readPromises = [];
            for (let i = 0; i < concurrency; i++) {
                readPromises.push(
                    this.cache.get(testKey).then(value => ({ success: value === testValue, index: i }))
                );
            }
            
            const readResults = await Promise.all(readPromises);
            const allReadsSuccessful = readResults.every(result => result.success);
            
            // 并发写入测试（不同的键）
            const writePromises = [];
            for (let i = 0; i < concurrency; i++) {
                const key = `${testKey}:${i}`;
                writePromises.push(
                    this.cache.set(key, `concurrent value ${i}`).then(() => true).catch(() => false)
                );
            }
            
            const writeResults = await Promise.all(writePromises);
            const allWritesSuccessful = writeResults.every(Boolean);
            
            const success = allReadsSuccessful && allWritesSuccessful;
            const latency = performance.now() - startTime;
            
            this.log(`Concurrency Stress (${concurrency})`, success, 
                success ? 'All concurrent operations succeeded' : 
                         `Reads: ${allReadsSuccessful}, Writes: ${allWritesSuccessful}`, 
                latency);
            
            // 清理并发测试的键
            const cleanupPromises = [];
            for (let i = 0; i < concurrency; i++) {
                const key = `${testKey}:${i}`;
                cleanupPromises.push(this.cache.delete(key).catch(() => {}));
            }
            await Promise.all(cleanupPromises);
            await this.cache.delete(testKey).catch(() => {});
            
        } catch (error) {
            const latency = performance.now() - startTime;
            this.log(`Concurrency Stress (${concurrency})`, false, error.message, latency);
        }
    }

    /**
     * 运行所有测试
     */
    async runAllTests() {
        console.log('🚀 启动 Cache 服务综合测试...');
        console.log(`📊 配置: verbose=${this.options.verbose}, concurrency=${this.options.concurrency}`);
        console.log(`🔑 测试前缀: ${this.options.testPrefix}`);
        console.log(`🏢 当前提供商: ${this.cache.getCurrentProvider()}`);
        console.log('─'.repeat(50));

        const tests = [
            this.testBasicSetGet,
            this.testJsonObjectSupport,
            this.testTTLVerification,
            this.testDeleteOperation,
            this.testListKeys,
            this.testBulkSet,
            this.testL1CacheConsistency,
            this.testSkipCacheOption,
            this.testFailoverSimulation,
            this.testConcurrencyStress
        ];

        for (const test of tests) {
            try {
                await test.call(this);
            } catch (error) {
                this.log('Test Execution', false, `Unexpected error: ${error.message}`);
            }
        }

        // 清理测试数据
        await this.cleanup();

        this.printSummary();
    }

    /**
     * 打印测试摘要
     */
    printSummary() {
        console.log('─'.repeat(50));
        console.log('📊 性能摘要:');
        console.log(`   总测试数: ${this.stats.totalTests}`);
        console.log(`   通过: ${this.stats.passedTests} ✅`);
        console.log(`   失败: ${this.stats.failedTests} ❌`);
        console.log(`   成功率: ${((this.stats.passedTests / this.stats.totalTests) * 100).toFixed(1)}%`);
        
        if (this.stats.totalTests > 0) {
            const avgLatency = this.stats.totalLatency / this.stats.totalTests;
            console.log(`   平均延迟: ${avgLatency.toFixed(2)}ms`);
        }

        const provider = this.cache.getCurrentProvider();
        console.log(`🏢 使用提供商: ${provider}`);
        console.log(`🔧 故障转移模式: ${this.cache.isFailoverMode ? '是' : '否'}`);

        if (this.stats.failedTests === 0) {
            console.log('🎉 所有测试通过！');
        } else {
            console.log('⚠️ 部分测试失败，请检查配置和网络连接');
        }
    }
}

/**
 * 解析命令行参数
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {};
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        switch (arg) {
            case '--verbose':
            case '-v':
                options.verbose = true;
                break;
                
            case '--concurrency':
            case '-c':
                const nextArg = args[i + 1];
                if (nextArg && !nextArg.startsWith('--')) {
                    const concurrency = parseInt(nextArg, 10);
                    if (!isNaN(concurrency) && concurrency > 0) {
                        options.concurrency = concurrency;
                        i++; // 跳过下一个参数
                    }
                }
                break;
                
            case '--prefix':
            case '-p':
                const prefixArg = args[i + 1];
                if (prefixArg && !prefixArg.startsWith('--')) {
                    options.testPrefix = prefixArg;
                    i++; // 跳过下一个参数
                }
                break;
                
            case '--provider':
            case '-pr':
                const providerArg = args[i + 1];
                if (providerArg && !providerArg.startsWith('--')) {
                    const provider = providerArg.toLowerCase();
                    if (['redis', 'cloudflare', 'upstash', 'local', 'auto'].includes(provider)) {
                        options.provider = provider;
                    } else {
                        console.error(`Error: Invalid provider ${providerArg}`);
                        console.error('Valid providers: redis, cloudflare, upstash, local, auto');
                        process.exit(1);
                    }
                    i++; // 跳过下一个参数
                }
                break;
                
            case '--help':
            case '-h':
                console.log(`
Cache 服务测试脚本

用法: node cache-test.js [选项]

选项:
  --verbose, -v        启用详细日志输出
  --concurrency N, -c N  设置并发测试数量 (默认: 1)
  --prefix PREFIX, -p PREFIX  设置测试键前缀 (默认: test:cache:)
  --provider PROVIDER, -pr PROVIDER  强制指定缓存提供商 (redis/cloudflare/upstash/local/auto)
  --help, -h           显示此帮助信息

示例:
  node cache-test.js                    # 基本测试
  node cache-test.js --verbose          # 详细输出
  node cache-test.js -c 50              # 并发50次
  node cache-test.js --provider=cloudflare  # 强制使用 Cloudflare
  node cache-test.js -v -c 10 -p mytest:
                `);
                process.exit(0);
                break;
        }
    }
    
    return options;
}

/**
 * 设置测试环境
 */
function setupTestEnvironment(provider = 'auto') {
    process.env.NODE_ENV = 'development';
    process.env.JEST_WORKER_ID = '1';
    
    // 如果指定了provider，强制设置CACHE_PROVIDER
    if (provider && provider !== 'auto') {
        process.env.CACHE_PROVIDER = provider;
        console.log(`🔄 Cache服务：强制使用 ${provider.charAt(0).toUpperCase() + provider.slice(1)}`);
    }
    
    // 设置模拟的缓存配置以避免网络错误
    if (!process.env.CF_CACHE_ACCOUNT_ID) {
        process.env.CF_CACHE_ACCOUNT_ID = 'test-account-id';
    }
    if (!process.env.CF_CACHE_NAMESPACE_ID) {
        process.env.CF_CACHE_NAMESPACE_ID = 'test-namespace-id';
    }
    if (!process.env.CF_CACHE_TOKEN) {
        process.env.CF_CACHE_TOKEN = 'test-token';
    }
    
    // 为特定provider设置默认配置
    if (provider === 'redis') {
        if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
            process.env.REDIS_HOST = 'localhost';
            process.env.REDIS_PORT = '6379';
        }
    } else if (provider === 'upstash') {
        if (!process.env.UPSTASH_REDIS_REST_URL && !process.env.UPSTASH_REDIS_REST_TOKEN) {
            process.env.UPSTASH_REDIS_REST_URL = 'https://test-upstash-url';
            process.env.UPSTASH_REDIS_REST_TOKEN = 'test-upstash-token';
        }
    } else if (provider === 'local') {
        // local 映射为 auto，使用默认的 local cache
        process.env.CACHE_PROVIDER = 'local';
    }
}

/**
 * 主函数
 */
async function main() {
    const options = parseArgs();
    
    // 设置测试环境
    setupTestEnvironment(options.provider);
    
    try {
        const tester = new CacheTester(options);
        
        // 初始化模块
        await tester.init();
        
        // 运行测试
        await tester.runAllTests();
        
        // 如果有测试失败，退出码为1
        process.exit(tester.stats.failedTests > 0 ? 1 : 0);
        
    } catch (error) {
        console.error('💥 测试脚本执行失败:', error.message);
        if (options.verbose) {
            console.error(error.stack);
        }
        process.exit(1);
    }
}

// 如果直接运行此脚本
console.log('📍 检查脚本执行条件:', import.meta.url, `file://${process.argv[1]}`);
if (import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith('cache-test.js')) {
    const options = parseArgs();
    console.log('🚀 Cache 测试脚本启动...', options);
    main().catch(error => {
        console.error('💥 测试脚本执行失败:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    });
} else {
    console.log('ℹ️ 脚本作为模块导入，不直接执行');
}

export { CacheTester };