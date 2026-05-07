## 2025-04-18 - Prevent Predictability in Distributed Lock Versioning
**Vulnerability:** Used insecure `Math.random()` to generate the version identifier for distributed locks.
**Learning:** `Math.random()` is not cryptographically secure, meaning generated identifiers are predictable. This predictability can lead to lock predictability, allowing potential attackers to guess lock version tokens, bypass validations, and hijack or steal task locks in distributed and concurrent environments.
**Prevention:** Always use cryptographically secure PRNGs (Pseudo-Random Number Generators) such as `crypto.randomUUID()` or `crypto.randomBytes(N).toString('hex')` to generate versioning or security-sensitive identifiers.

## 2025-05-08 - Prevent Path Traversal in Telegram File Downloads
**Vulnerability:** Extracted file names from Telegram message attributes (`obj.attributes?.find(a => a.fileName)?.fileName`) were used without sanitization in `path.join(config.downloadDir, fileName)`.
**Learning:** If a malicious user sends a file with a crafted filename containing directory traversal sequences (e.g., `../../../etc/passwd`), it could overwrite arbitrary files on the system (Path Traversal / Arbitrary File Write). Untrusted input directly used in path construction is highly dangerous.
**Prevention:** Always sanitize filenames from external or untrusted sources using `path.basename()` before combining them with base directories.
