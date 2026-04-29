## 2026-04-30 - Replace insecure Math.random() with Web Crypto API for Drive ID Generation
**Vulnerability:** Weak PRNG (`Math.random()`) used for generating security identifiers (`driveId`).
**Learning:** In Cloudflare/Edge environments, importing Node.js `crypto` via bare imports (e.g., `import crypto from "crypto";`) breaks builds and tests. The `crypto` module is not natively available like in Node.
**Prevention:** Use the globally available Web Crypto API (`crypto.randomUUID()`) for generating secure pseudo-random IDs without requiring imports, ensuring compatibility across Node and Edge execution contexts.
