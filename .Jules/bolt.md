
## 2026-05-16 - Prevent N+1 queries in DriveRepository
**Learning:** Sequential `UPDATE` and `DELETE` operations inside an async loop (e.g. `for (const drive of drives) { await d1.run(...); }`) over arrays of items create N+1 query bottlenecks and increased network overhead.
**Action:** Replaced sequential DB updates with a parameterized `IN (...)` clause for the database and used `cache.batchOperation` for concurrent cache invalidation. When dealing with similar iterations in data-access layers, always look for batch API operations.
