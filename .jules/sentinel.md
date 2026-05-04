## 2025-04-18 - Prevent Predictability in Distributed Lock Versioning
**Vulnerability:** Used insecure `Math.random()` to generate the version identifier for distributed locks.
**Learning:** `Math.random()` is not cryptographically secure, meaning generated identifiers are predictable. This predictability can lead to lock predictability, allowing potential attackers to guess lock version tokens, bypass validations, and hijack or steal task locks in distributed and concurrent environments.
**Prevention:** Always use cryptographically secure PRNGs (Pseudo-Random Number Generators) such as `crypto.randomUUID()` or `crypto.randomBytes(N).toString('hex')` to generate versioning or security-sensitive identifiers.

## 2026-05-01 - Path Traversal via Unsanitized Telegram File Names
**Vulnerability:** File names extracted from Telegram media attributes were used directly in `path.join()` without sanitization, allowing potential Path Traversal attacks (e.g., if a file name was `../../../etc/passwd`).
**Learning:** External user input, even from seemingly trusted platforms like Telegram, cannot be trusted. If a malicious user sends a file with a crafted name containing directory traversal characters (`..`), it could lead to arbitrary file creation, overwrite, or access on the server filesystem.
**Prevention:** Always sanitize file names derived from external sources using `path.basename()` before combining them with base directories to ensure they resolve to a single file within the intended directory, effectively neutralizing path traversal attempts.
