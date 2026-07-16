## 2024-05-18 - Concurrent Cache Batch Operations Fix
**Learning:** `CacheService.batchOperation` was using a sequential `for...of` loop which causes N+1 I/O wait problems for cache batches. While doing the `Promise.all` optimization, we also noticed a subtle bug: the old loop accidentally passed `op.type` (`'get'`) as the format param in the `get` call, instead of a data type format like `'json'`.
**Action:** When parallelizing operations in arrays, make sure to double check that we maintain isolated error handling per element (by catching inside the `.map`) and correctly map the result schema, especially for 1:1 inputs-to-outputs mapping (i.e. explicitly returning failures for unrecognized types so we don't accidentally drop array items). Ensure no dependency is implicitly added during debugging.
## 2024-05-18 - [Batch Processor Memory Footprint]
**Learning:** Using `array.map` with `PQueue` for batch processing creates an upfront closure for every item in the array. In Node.js, this causes an excessive memory footprint and triggers aggressive garbage collection when processing thousands of tasks, acting as a massive hidden performance bottleneck.
**Action:** For performance-critical code iterating over arrays with promises, replace `array.map` with a native async worker pool using a pre-allocated fixed-size results array (`new Array(length)`) and a `while` loop iterating via a shared cursor.
## 2024-05-18 - [Native Async Worker Pool Optimization in CacheService]
**Learning:** For batch operations in \`CacheService.js\`, using unbounded \`Promise.all(operations.map(...))\` causes excessive memory allocation from upfront closures and can exhaust connection pools for large inputs.
**Action:** Replace \`operations.map\` with a native async worker pool using a pre-allocated array and a concurrency limit (e.g., 5) to balance throughput with resource constraints.

## 2024-05-13 - Optimize executeBatch memory footprint and concurrency
**Learning:** In highly concurrent utility methods like `SmartFailover.executeBatch`, using `Promise.allSettled(array.map(...))` coupled with `{...options}` inside the `.map()` iterates the object's properties creating unnecessary heap allocation pressure per execution. Furthermore, fallback serial processing using `Object.create(options)` created objects with properties attached to the prototype chain which can cause tricky regressions downstream in loops relying on "own properties".
## 2026-07-16 - Continuous Async Worker Pool for Batch Processing
**Learning:** When parallelizing batch tasks (e.g., in `CacheService.preheat`), chunked execution loops using `tasks.slice()` combined with `Promise.allSettled(batch.map(...))` cause head-of-line blocking and memory overhead from closures.
**Action:** Replace chunked execution loops with a continuous native async worker pool using a shared atomic cursor (`currentIndex++`) to maximize throughput and reduce memory allocation.
