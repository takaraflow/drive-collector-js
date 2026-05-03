## 2025-04-18 - Prevent Predictability in Distributed Lock Versioning
**Vulnerability:** Used insecure `Math.random()` to generate the version identifier for distributed locks.
**Learning:** `Math.random()` is not cryptographically secure, meaning generated identifiers are predictable. This predictability can lead to lock predictability, allowing potential attackers to guess lock version tokens, bypass validations, and hijack or steal task locks in distributed and concurrent environments.
**Prevention:** Always use cryptographically secure PRNGs (Pseudo-Random Number Generators) such as `crypto.randomUUID()` or `crypto.randomBytes(N).toString('hex')` to generate versioning or security-sensitive identifiers.
## 2024-05-18 - Fix Path Traversal Vulnerability in File Handling
**Vulnerability:** File paths were constructed by directly joining a base directory (`config.downloadDir`) with an unsanitized filename retrieved from an external source or database (e.g., `row.file_name`, `info.name`).
**Learning:** Using `path.join` with unsanitized user-controlled input can lead to path traversal vulnerabilities. For instance, if `info.name` is `../../../etc/passwd`, the resulting path would escape the intended base directory.
**Prevention:** Always sanitize filenames from external or untrusted sources using `path.basename()` before combining them with base directories to ensure the path remains confined to the intended folder.
