
## 2024-05-18 - [Add human-readable file sizes]
**Learning:** Hardcoding MB as the unit for file sizes (`(bytes / 1048576).toFixed(1) + " MB"`) leads to unreadable 0.0 MB for very small files and bloated numbers for multi-gigabyte files (e.g. 2560.0 MB instead of 2.5 GB), impacting UX in progress indicators and file listings.
**Action:** Created a `formatBytes` utility in `src/utils/common.js` to automatically scale byte counts into B, KB, MB, GB, etc. with appropriate precision, improving readability across the UI (`renderProgress` and `renderFilesPage`).
## 2024-04-28 - Empty State Call-to-Actions
**Learning:** Telegram bot users frequently encounter empty states (like an empty directory or no task history). Simply stating the state (e.g., "Empty Directory") is insufficient and leaves the user at a dead end.
**Action:** When designing or refactoring UI text in conversational interfaces (e.g., strings in `src/locales/zh-CN.js`), always append clear, actionable call-to-actions (CTAs), such as "Please send a file or link directly to save it to this directory," instead of just describing the empty state.
