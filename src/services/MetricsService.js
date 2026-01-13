/**
 * MetricsService - 简单的指标收集服务
 * 用于收集和报告队列操作的关键性能指标
 */

export class MetricsService {
    constructor() {
        this.counters = new Map();
        this.gauges = new Map();
        this.timings = new Map();
    }

    /**
     * 增加计数器
     * @param {string} name - 指标名称
     * @param {number} value - 增加的值，默认为1
     */
    increment(name, value = 1) {
        const current = this.counters.get(name) || 0;
        this.counters.set(name, current + value);
    }

    /**
     * 设置仪表值
     * @param {string} name - 指标名称
     * @param {number} value - 仪表值
     */
    gauge(name, value) {
        this.gauges.set(name, value);
    }

    /**
     * 记录时间指标
     * @param {string} name - 指标名称
     * @param {number} duration - 持续时间（毫秒）
     */
    timing(name, duration) {
        if (!this.timings.has(name)) {
            this.timings.set(name, []);
        }
        this.timings.get(name).push(duration);
    }

    /**
     * 获取指标快照
     * @returns {Object} 包含所有指标的对象
     */
    getMetrics() {
        const result = {
            counters: Object.fromEntries(this.counters),
            gauges: Object.fromEntries(this.gauges),
            timings: {}
        };

        // 计算时间指标的统计信息
        for (const [name, durations] of this.timings) {
            if (durations.length > 0) {
                const sum = durations.reduce((a, b) => a + b, 0);
                const avg = sum / durations.length;
                const max = Math.max(...durations);
                const min = Math.min(...durations);
                
                result.timings[name] = {
                    count: durations.length,
                    average: Math.round(avg * 100) / 100,
                    max,
                    min,
                    total: sum
                };
            }
        }

        return result;
    }

    /**
     * 重置所有指标
     */
    reset() {
        this.counters.clear();
        this.gauges.clear();
        this.timings.clear();
    }

    /**
     * 获取单个指标的值
     * @param {string} name - 指标名称
     * @returns {number|undefined} 指标值
     */
    getCounter(name) {
        return this.counters.get(name);
    }

    getGauge(name) {
        return this.gauges.get(name);
    }
}

// 创建全局单例实例
export const metrics = new MetricsService();

export default MetricsService;