## 2024-05-18 - [Weak Randomness for Security Tokens]
**Vulnerability:** Weak PRNG `Math.random()` was used to generate `version` strings for distributed lock tokens in `src/services/DistributedLock.js`.
**Learning:** This is an insecure randomness pattern, predictable tokens can lead to attackers guessing lock IDs to improperly hijack or release distributed locks. Other files also have this weak pattern.
**Prevention:** Use cryptographically secure pseudorandom number generators (CSPRNG) like `crypto.randomBytes(N).toString('hex')` or `crypto.randomUUID()` when generating tokens that require unpredictability.
