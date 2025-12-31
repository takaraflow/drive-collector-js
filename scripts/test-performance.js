#!/usr/bin/env node

/**
 * 测试性能监控脚本
 * 用于测量和分析测试执行时间，帮助识别性能瓶颈
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

class TestPerformanceMonitor {
    constructor() {
        this.results = [];
        this.startTime = Date.now();
    }

    async runTests() {
        console.log('🚀 开始测试性能监控...\n');
        const startUsage = process.cpuUsage();
        const startMem = process.memoryUsage().heapUsed;

        return new Promise((resolve, reject) => {
            const testProcess = spawn('npm', ['run', 'test:full-optimized'], {
                cwd: process.cwd(),
                shell: true,
                stdio: ['inherit', 'pipe', 'pipe']
            });

            let output = '';
            let errorOutput = '';

            testProcess.stdout.on('data', (data) => {
                output += data.toString();
                process.stdout.write(data);
            });

            testProcess.stderr.on('data', (data) => {
                errorOutput += data.toString();
                process.stderr.write(data);
            });

            testProcess.on('close', (code) => {
                const endTime = Date.now();
                const duration = endTime - this.startTime;

                console.log(`\n📊 测试执行完成`);
                console.log(`⏱️  总耗时: ${this.formatTime(duration)}`);
                console.log(` exit code: ${code}`);

                // 解析输出获取详细信息
                this.analyzeResults(output, duration, code);
                resolve();
            });

            testProcess.on('error', (err) => {
                console.error('❌ 测试执行失败:', err);
                reject(err);
            });
        });
    }

    analyzeResults(output, duration, exitCode) {
        // 提取测试套件信息
        const testSuitesMatch = output.match(/Test Suites:\s+(\d+)\s+passed,\s+(\d+)\s+total/);
        const testsMatch = output.match(/Tests:\s+(\d+)\s+passed,\s+(\d+)\s+total/);
        const timeMatch = output.match(/Time:\s+([\d.]+)\s+s/);

        const results = {
            timestamp: new Date().toISOString(),
            duration: duration,
            durationFormatted: this.formatTime(duration),
            exitCode: exitCode,
            testSuites: testSuitesMatch ? {
                passed: parseInt(testSuitesMatch[1]),
                total: parseInt(testSuitesMatch[2])
            } : null,
            tests: testsMatch ? {
                passed: parseInt(testsMatch[1]),
                total: parseInt(testsMatch[2])
            } : null,
            reportedTime: timeMatch ? parseFloat(timeMatch[1]) : null
        };

        // 保存结果到文件
        this.saveResults(results);

        // 显示性能摘要
        this.displaySummary(results);

        // 提供优化建议
        this.provideOptimizationSuggestions(results);
    }

    displaySummary(results) {
        console.log('\n📈 性能摘要:');
        console.log('─'.repeat(50));
        
        if (results.testSuites) {
            console.log(`测试套件: ${results.testSuites.passed}/${results.testSuites.total} 通过`);
        }
        
        if (results.tests) {
            console.log(`测试用例: ${results.tests.passed}/${results.tests.total} 通过`);
        }

        console.log(`实际耗时: ${results.durationFormatted}`);
        
        if (results.reportedTime) {
            console.log(`报告耗时: ${results.reportedTime}s`);
        }

        // 计算平均测试时间
        if (results.tests && results.tests.total > 0) {
            const avgTime = results.duration / results.tests.total;
            console.log(`平均测试时间: ${avgTime.toFixed(2)}ms/测试`);
        }

        console.log('─'.repeat(50));
    }

    provideOptimizationSuggestions(results) {
        console.log('\n💡 优化建议:');
        console.log('─'.repeat(50));

        const suggestions = [];

        // 检查总耗时
        if (results.duration > 60000) {
            suggestions.push('⚠️  总耗时超过60秒，考虑以下优化:');
            suggestions.push('   - 使用 jest --maxWorkers=50% 提高并行度');
            suggestions.push('   - 减少集成测试中的实际等待时间');
            suggestions.push('   - 使用 jest.useFakeTimers() 替代真实定时器');
        }

        // 检查测试数量
        if (results.tests && results.tests.total > 500) {
            suggestions.push('⚠️  测试数量较多，考虑:');
            suggestions.push('   - 将测试分组运行');
            suggestions.push('   - 使用 jest --testNamePattern 运行特定测试');
        }

        // 检查平均测试时间
        if (results.tests && results.tests.total > 0) {
            const avgTime = results.duration / results.tests.total;
            if (avgTime > 100) {
                suggestions.push('⚠️  平均测试时间较高，考虑:');
                suggestions.push('   - 优化测试 setup/teardown');
                suggestions.push('   - 减少不必要的 mock 重置');
                suggestions.push('   - 使用 describe 块共享 setup');
            }
        }

        if (suggestions.length === 0) {
            suggestions.push('✅ 测试性能良好，无需紧急优化');
        }

        suggestions.forEach(s => console.log(s));
        console.log('─'.repeat(50));
    }

    saveResults(results) {
        const resultsDir = path.join(process.cwd(), 'test-results');
        const resultsFile = path.join(resultsDir, `performance-${Date.now()}.json`);

        if (!fs.existsSync(resultsDir)) {
            fs.mkdirSync(resultsDir, { recursive: true });
        }

        fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
        console.log(`\n💾 结果已保存: ${resultsFile}`);
    }

    formatTime(ms) {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
        return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
    }

    // 生成性能报告
    generateReport() {
        const resultsDir = path.join(process.cwd(), 'test-results');
        if (!fs.existsSync(resultsDir)) {
            console.log('❌ 没有找到测试结果数据');
            return;
        }

        const files = fs.readdirSync(resultsDir)
            .filter(f => f.startsWith('performance-') && f.endsWith('.json'))
            .sort()
            .slice(-10); // 只取最近10次

        if (files.length === 0) {
            console.log('❌ 没有找到历史测试结果');
            return;
        }

        console.log('\n📊 历史性能报告:');
        console.log('─'.repeat(80));
        console.log('时间戳'.padEnd(25) + '耗时'.padEnd(15) + '测试数'.padEnd(15) + '状态');
        console.log('─'.repeat(80));

        files.forEach(file => {
            const data = JSON.parse(fs.readFileSync(path.join(resultsDir, file), 'utf8'));
            const time = new Date(data.timestamp).toLocaleTimeString();
            const duration = this.formatTime(data.duration);
            const testCount = data.tests ? `${data.tests.passed}/${data.tests.total}` : 'N/A';
            const status = data.exitCode === 0 ? '✅' : '❌';

            console.log(`${time.padEnd(25)}${duration.padEnd(15)}${testCount.padEnd(15)}${status}`);
        });

        console.log('─'.repeat(80));
    }
}

// 命令行接口
async function main() {
    const args = process.argv.slice(2);
    const monitor = new TestPerformanceMonitor();

    if (args.includes('--report')) {
        monitor.generateReport();
        return;
    }

    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
测试性能监控工具

用法:
  node test-performance.js [选项]

选项:
  --report    生成历史性能报告
  --help, -h  显示此帮助信息

示例:
  node test-performance.js          # 运行测试并监控性能
  node test-performance.js --report # 查看历史性能报告
        `);
        return;
    }

    await monitor.runTests();
}

main().catch(console.error);