## 2024-05-05 - Path Traversal in TaskManager

**Vulnerability:** Discovered a path traversal vulnerability in `src/processor/TaskManager.js`, `src/processor/TaskManager/TaskManager.core.js`, and `src/processor/TaskManager/TaskManager.download.js`. External inputs (`row.file_name`, `dbTask.file_name`, `task.fileName`, `info.name`) were concatenated with `config.downloadDir` using `path.join()` without sanitization.

**Learning:** This pattern existed because the application implicitly trusted database records and message metadata when recreating local file paths during task resumption or uploading. It assumed that files saved locally by the bot would always have clean names, ignoring that the initial file names could originate from untrusted Telegram messages.

**Prevention:** Always wrap external or untrusted file names in `path.basename()` before combining them with root directories using `path.join()`. This ensures that any directory traversal attempts (e.g., `../../../`) are stripped, locking the file reference purely to the intended directory.
