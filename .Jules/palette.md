
## 2024-05-18 - [Add human-readable file sizes]
**Learning:** Hardcoding MB as the unit for file sizes (`(bytes / 1048576).toFixed(1) + " MB"`) leads to unreadable 0.0 MB for very small files and bloated numbers for multi-gigabyte files (e.g. 2560.0 MB instead of 2.5 GB), impacting UX in progress indicators and file listings.
**Action:** Created a `formatBytes` utility in `src/utils/common.js` to automatically scale byte counts into B, KB, MB, GB, etc. with appropriate precision, improving readability across the UI (`renderProgress` and `renderFilesPage`).
## 2026-04-27 - Context-Specific Empty States with CTAs
**Learning:** Reusing generalized empty state strings (like 'directory is empty or loading') across different contexts (like a batch task monitor) leads to confusing UI messages. Furthermore, empty states without actionable guidance leave users wondering what to do next.
**Action:** Always create context-specific empty state strings (e.g., `batch_empty` for the batch monitor) and ensure they include clear Call-To-Actions (CTAs) using `💡 <b>提示:</b> ...` formatting to instruct users on how to populate the empty view. When updating strings in `src/locales/zh-CN.js`, remember to update any mocked strings in the corresponding test files (e.g., `__tests__/ui/templates.test.js`) to prevent text-matching assertion failures.
