## 2025-04-18 - Prevent Predictability in Distributed Lock Versioning
**Vulnerability:** Used insecure `Math.random()` to generate the version identifier for distributed locks.
**Learning:** `Math.random()` is not cryptographically secure, meaning generated identifiers are predictable. This predictability can lead to lock predictability, allowing potential attackers to guess lock version tokens, bypass validations, and hijack or steal task locks in distributed and concurrent environments.
**Prevention:** Always use cryptographically secure PRNGs (Pseudo-Random Number Generators) such as `crypto.randomUUID()` or `crypto.randomBytes(N).toString('hex')` to generate versioning or security-sensitive identifiers.

## 2026-05-09 - Prevent Path Traversal in Local File Operations
**Vulnerability:** Unsanitized file names from untrusted sources (e.g., database fields like `row.file_name` or Telegram attributes) were directly concatenated with `config.downloadDir` using `path.join()`.
**Learning:** This pattern creates a critical path traversal vulnerability. If an attacker controls the file name and inputs something like `../../etc/passwd`, the application could read, write, or delete arbitrary files outside the intended directory.
**Prevention:** Always sanitize file names from external or untrusted sources using `path.basename()` before combining them with base directories to ensure they are restricted to a single directory level.
## 2025-05-13 - Prevent Information Exposure via Logged Secrets
**Vulnerability:** A `log.error` statement was outputting the first 5 characters of a sensitive token (`this.token?.substring(0, 5)`) upon authentication failure.
**Learning:** Logging partial tokens is unsafe. Even truncated pieces of secrets can provide valuable clues for an attacker during a brute-force attack or when attempting to identify compromised credentials among various leaks. Information exposure through logs breaks the "defense in depth" principle and increases risk.
**Prevention:** Never log substrings or snippets of API keys, passwords, or authentication tokens. Instead, only log non-sensitive metadata, such as token length or presence/absence indicators, to provide debugging context without leaking the actual secret.
## 2026-07-02 - Prevent Predictability in StreamTransferService Token Generation
**Vulnerability:** The finalization token (`finalizeToken`) used in `StreamTransferService` was generated using `Math.random()`, which is predictable and not cryptographically secure.
**Learning:** Generating security-sensitive identifiers or tokens using `Math.random()` creates predictability vulnerabilities, potentially allowing attackers to guess tokens and hijack resumable upload finalizations.
**Prevention:** Always use cryptographically secure PRNGs (Pseudo-Random Number Generators) such as `crypto.randomUUID()` or `crypto.randomBytes(N).toString('hex')` to generate security-sensitive identifiers.
