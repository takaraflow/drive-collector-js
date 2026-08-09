## 2026-08-09 - D1 Batch Optimization for N+1 HTTP Requests
**Learning:** Using `Promise.all` with `d1.fetchOne`/`d1.fetchAll` executes concurrent queries but still incurs the overhead of multiple separate HTTP roundtrips to Cloudflare D1. This creates a bottleneck.
**Action:** Use `d1.batch()` to consolidate multiple queries into a single HTTP payload, effectively eliminating N+1 network requests to D1.
