## 💡 What
Replaced unbounded `for (const id of activeIds)` sequential await loops in `InstanceRepository.findAll` and `DriveRepository.findAll` with a bounded (concurrency: 5) native async worker pool using pre-allocated arrays.

## 🎯 Why
Iterating through a list of IDs and performing sequential cache/database lookups causes an N+1 I/O wait problem, blocking the event loop on each sequential read. By executing these queries concurrently with a small concurrency limit, we reduce overall wait time without overwhelming the connection pools, while preserving the array order using pre-allocated arrays (`new Array(length)`).

## 📊 Impact
Reduces execution time for multi-instance and multi-drive lookups from `O(N)` to `O(N/5)`, lowering latency significantly for heavily multi-tenant setups while capping concurrent connections.

## 🔬 Measurement
Verify the optimizations logic by reviewing the updated functions and verifying that the Vitest test suite passes successfully (`pnpm run ci:full`).
