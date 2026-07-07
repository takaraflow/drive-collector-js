import { cache } from "./src/services/CacheService.js";
import { TaskRepository } from "./src/repositories/TaskRepository.js";

async function run() {
    await cache.set("instance:1", { id: "1", lastHeartbeat: Date.now(), activeTaskCount: 5 }, 60);
    await cache.set("instance:2", { id: "2", lastHeartbeat: Date.now(), activeTaskCount: 10 }, 60);

    console.time("getActiveTaskCount (allSettled)");
    for(let i=0; i<100; i++) {
        await TaskRepository.getActiveTaskCount();
    }
    console.timeEnd("getActiveTaskCount (allSettled)");

    // Simulate what the new code would look like
    TaskRepository.INSTANCE_PREFIX = "instance:";
    TaskRepository.INSTANCE_STALE_MS = 60000;
    TaskRepository.getActiveTaskCountConcurrent = async function() {
        const instanceKeys = await cache.listKeys(this.INSTANCE_PREFIX);
        if (Array.isArray(instanceKeys) && instanceKeys.length > 0) {
            const now = Date.now();
            const concurrencyLimit = 5;
            const results = new Array(instanceKeys.length);
            let currentIndex = 0;

            const worker = async () => {
                while(currentIndex < instanceKeys.length) {
                    const i = currentIndex++;
                    try {
                        const data = await cache.get(instanceKeys[i], 'json', { cacheTtl: 30000 });
                        results[i] = { status: 'fulfilled', value: data };
                    } catch (e) {
                        results[i] = { status: 'rejected', reason: e };
                    }
                }
            };

            const workers = [];
            for (let i = 0; i < Math.min(concurrencyLimit, instanceKeys.length); i++) {
                workers.push(worker());
            }
            await Promise.all(workers);

            let sum = 0;
            let hasAny = false;

            results.forEach((result) => {
                if (result.status !== 'fulfilled') return;
                const data = result.value;
                if (!data) return;

                const lastHeartbeat = Number.parseInt(data.lastHeartbeat, 10);
                if (Number.isFinite(lastHeartbeat) && now - lastHeartbeat > this.INSTANCE_STALE_MS) {
                    return;
                }

                const count = Number.parseInt(data.activeTaskCount, 10);
                if (!Number.isFinite(count) || Number.isNaN(count)) return;
                hasAny = true;
                sum += Math.max(0, count);
            });

            if (hasAny) return sum;
        }
        return 0;
    }

    console.time("getActiveTaskCount (concurrent worker)");
    for(let i=0; i<100; i++) {
        await TaskRepository.getActiveTaskCountConcurrent();
    }
    console.timeEnd("getActiveTaskCount (concurrent worker)");
}

run().catch(console.error).finally(() => process.exit(0));
