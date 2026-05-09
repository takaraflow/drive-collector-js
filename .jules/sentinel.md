## 2025-04-18 - Prevent Predictability in Distributed Lock Versioning
**Vulnerability:** Used insecure `Math.random()` to generate the version identifier for distributed locks.
**Learning:** `Math.random()` is not cryptographically secure, meaning generated identifiers are predictable. This predictability can lead to lock predictability, allowing potential attackers to guess lock version tokens, bypass validations, and hijack or steal task locks in distributed and concurrent environments.
**Prevention:** Always use cryptographically secure PRNGs (Pseudo-Random Number Generators) such as `crypto.randomUUID()` or `crypto.randomBytes(N).toString('hex')` to generate versioning or security-sensitive identifiers.

## 2026-05-09 - Prevent Path Traversal in Local File Operations
**Vulnerability:** Unsanitized file names from untrusted sources (e.g., database fields like `row.file_name` or Telegram attributes) were directly concatenated with `config.downloadDir` using `path.join()`.
**Learning:** This pattern creates a critical path traversal vulnerability. If an attacker controls the file name and inputs something like `../../etc/passwd`, the application could read, write, or delete arbitrary files outside the intended directory.
**Prevention:** Always sanitize file names from external or untrusted sources using `path.basename()` before combining them with base directories to ensure they are restricted to a single directory level.

## 2024-05-09 - Replace Math.random with cryptographically secure PRNG
**Vulnerability:** Predictable IDs generated using Math.random().
**Learning:** Math.random() is predictable and shouldn't be used for IDs.
**Prevention:** Always use crypto.randomUUID() or other cryptographically secure PRNGs.
