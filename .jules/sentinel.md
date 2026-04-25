## 2025-04-18 - Prevent Predictability in Distributed Lock Versioning
**Vulnerability:** Used insecure `Math.random()` to generate the version identifier for distributed locks.
**Learning:** `Math.random()` is not cryptographically secure, meaning generated identifiers are predictable. This predictability can lead to lock predictability, allowing potential attackers to guess lock version tokens, bypass validations, and hijack or steal task locks in distributed and concurrent environments.
**Prevention:** Always use cryptographically secure PRNGs (Pseudo-Random Number Generators) such as `crypto.randomUUID()` or `crypto.randomBytes(N).toString('hex')` to generate versioning or security-sensitive identifiers.
## 2024-05-24 - [Fix Predictable Distributed Lock Values]
**Vulnerability:** Predictable pseudo-random number generator (`Math.random()`) was being used for generating lock tokens/values in distributed lock implementations (`UpstashRHCache` and `CloudflareKVCache`).
**Learning:** Using `Math.random()` in distributed contexts like locks introduces predictability and hijacking vulnerabilities, making the locks susceptible to race conditions and token guessing attacks.
**Prevention:** Always use cryptographically secure PRNGs (e.g., `crypto.randomUUID()`) when generating IDs, tokens, or versions in security-sensitive or distributed contexts to ensure unpredictability.
