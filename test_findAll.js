import { cache } from "./src/services/CacheService.js";
import { InstanceRepository } from "./src/repositories/InstanceRepository.js";

async function run() {
    await cache.set("instance:1", { id: "1", lastHeartbeat: Date.now() }, 60);
    await cache.set("instance:2", { id: "2", lastHeartbeat: Date.now() }, 60);

    console.time("findAll (sequential)");
    const instances = await InstanceRepository.findAll();
    console.timeEnd("findAll (sequential)");
    console.log(instances.length, "instances found");

    console.time("findAll (concurrent)");
    const keys = await cache.listKeys(InstanceRepository.PREFIX);
    const readOptions = InstanceRepository._readOptions({});

    // Concurrent fetch using native async worker pool
    const concurrencyLimit = 5;
    const results = new Array(keys.length);
    let currentIndex = 0;
    const worker = async () => {
        while(currentIndex < keys.length) {
            const i = currentIndex++;
            const data = await cache.get(keys[i], "json", readOptions);
            results[i] = data;
        }
    };

    const workers = [];
    for (let i = 0; i < Math.min(concurrencyLimit, keys.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);

    const concurrentInstances = results.filter(Boolean);
    console.timeEnd("findAll (concurrent)");
    console.log(concurrentInstances.length, "instances found");
}

run().catch(console.error).finally(() => process.exit(0));
