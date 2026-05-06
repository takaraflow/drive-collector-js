## 2025-04-18 - Prevent Predictability in Distributed Lock Versioning
**Vulnerability:** Used insecure `Math.random()` to generate the version identifier for distributed locks.
**Learning:** `Math.random()` is not cryptographically secure, meaning generated identifiers are predictable. This predictability can lead to lock predictability, allowing potential attackers to guess lock version tokens, bypass validations, and hijack or steal task locks in distributed and concurrent environments.
**Prevention:** Always use cryptographically secure PRNGs (Pseudo-Random Number Generators) such as `crypto.randomUUID()` or `crypto.randomBytes(N).toString('hex')` to generate versioning or security-sensitive identifiers.

## 2024-05-06 - Prevent Path Traversal in Download Directories
**Vulnerability:** User input (`info.name`, `dbTask.file_name`) was used directly in `path.join` to create file paths for saving downloads.
**Learning:** File names originating from Telegram message attributes or database tasks can contain path traversal characters (e.g., `../`), potentially allowing attackers to write files outside the intended directory.
**Prevention:** Always use `path.basename()` to sanitize file names from external/untrusted sources before combining them with base directories.
