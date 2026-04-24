## 2025-04-18 - Prevent Predictability in Distributed Lock Versioning
**Vulnerability:** Used insecure `Math.random()` to generate the version identifier for distributed locks.
**Learning:** `Math.random()` is not cryptographically secure, meaning generated identifiers are predictable. This predictability can lead to lock predictability, allowing potential attackers to guess lock version tokens, bypass validations, and hijack or steal task locks in distributed and concurrent environments.
**Prevention:** Always use cryptographically secure PRNGs (Pseudo-Random Number Generators) such as `crypto.randomUUID()` or `crypto.randomBytes(N).toString('hex')` to generate versioning or security-sensitive identifiers.
## 2024-04-24 - [Insecure PRNG for Distributed Locks]
**Vulnerability:** Predictable lock tokens/values generated using `Math.random()` in `UpstashRHCache.js` and `CloudflareKVCache.js` instead of cryptographically secure alternatives.
**Learning:** `Math.random()` is not cryptographically secure and may allow predictability, opening up possibilities for race conditions or lock hijacking by adversaries guessing the generated values.
**Prevention:** Always use cryptographically secure Pseudo-Random Number Generators (e.g. `crypto.randomUUID()`) when generating unique tokens for sensitive or state-controlling features such as distributed locks.
