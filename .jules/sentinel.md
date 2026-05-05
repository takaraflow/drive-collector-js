## 2025-04-18 - Prevent Predictability in Distributed Lock Versioning
**Vulnerability:** Used insecure `Math.random()` to generate the version identifier for distributed locks.
**Learning:** `Math.random()` is not cryptographically secure, meaning generated identifiers are predictable. This predictability can lead to lock predictability, allowing potential attackers to guess lock version tokens, bypass validations, and hijack or steal task locks in distributed and concurrent environments.
**Prevention:** Always use cryptographically secure PRNGs (Pseudo-Random Number Generators) such as `crypto.randomUUID()` or `crypto.randomBytes(N).toString('hex')` to generate versioning or security-sensitive identifiers.
## 2026-05-05 - Path Traversal Vulnerability Fix
**Vulnerability:** User input filenames (e.g., `row.file_name`, `dbTask.file_name`, `task.fileName`) were used directly with `path.join(config.downloadDir, ...)` without sanitization, leading to a path traversal vulnerability. An attacker could potentially construct malicious filenames (e.g., `../../etc/passwd`) to read or overwrite files outside the intended `downloadDir`.
**Learning:** Never trust filenames from databases or external sources, even if they were originally parsed internally, especially when constructing filesystem paths.
**Prevention:** Always sanitize filenames from untrusted or external sources using `path.basename()` before combining them with base directories to prevent directory traversal attacks.
