💡 What: Replaced sequential \`for...of\` loops with \`Promise.all\` array mapping in \`DriveRepository\` and \`InstanceRepository\` to hydrate cached models concurrently. Also applied concurrent promise execution to legacy drive format migration logic.

🎯 Why: Node.js executes sequential \`await\` loops by repeatedly yielding back to the event loop, acting as a massive hidden performance bottleneck (N+1 I/O waits) when fetching items in a batch. By firing them all concurrently and awaiting them in parallel, we allow the networking layer/DB to serve requests optimally.

📊 Impact: Execution time drops from O(N) to O(1) concurrent cache/DB roundtrips, significantly decreasing latency and unblocking the main thread faster during batch read paths.

🔬 Measurement: Verify cache and DB request latencies drop during \`/drives\` list or internal task preload routines that iterate through multiple instances/drives. Ensure all repository tests (\`pnpm run ci:test -- src/repositories/\`) still pass reliably.
