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
**Action:** Replace `array.map()` and `Promise.allSettled()` with a native async worker pool using a pre-allocated array (`results.length = len`). Ensure concurrency behavior is preserved by defaulting the async worker length to the length of the batch if concurrency isn't specified explicitly. Use `Object.assign({}, options)` instead of object spread inside hot loops for lower allocation overhead while safely producing objects with "own properties".

## 2026-06-26 - Parallelize sequential cache lookups
**Learning:** Sequential `for...of` loops when fetching items by ID (like in `DriveRepository` and `InstanceRepository`) create N+1 I/O wait problems. This causes significant delays when loading multiple entities.
**Action:** Use concurrent `Promise.all(ids.map(id => fetchById(id).catch(...)))` to parallelize I/O bound fetch operations with isolated error handling and filter out nulls instead of accumulating them sequentially.

## 2026-06-26 - Parallelize sequential cache lookups with concurrency control
**Learning:** Sequential `for...of` loops when fetching items by ID create N+1 I/O wait problems. However, blindly replacing them with unbounded `Promise.all(ids.map(...))` is unsafe, as it can overwhelm connection pools or rate limits for large lists, and mapping with an inner `.catch()` alters fail-fast error semantics to silent filtering, risking regressions.
**Action:** Use a native async worker pool with a pre-allocated array (e.g. `new Array(length)`) and a strict concurrency limit (e.g., 5) to balance throughput with resource constraints, allowing any inner errors to bubble up naturally.

## 2026-06-26 - Prevent background processing leaks in async worker pools
**Learning:** When using an async worker pool to limit concurrency, a simple `throw err` inside the worker only rejects the outer `Promise.all`, but does not stop other running workers from continuing to process the remaining array elements. This can lead to severe resource exhaustion (e.g. bombarding a down database) as workers silently process the background queue.
**Action:** Always include a shared cancellation flag (e.g., `let hasError = false;`) and check it in the worker's loop condition (`while (currentIndex < length && !hasError)`) to ensure true fail-fast behavior and stop remaining queue processing upon any error.
