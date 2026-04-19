
## 2024-05-18 - [Add human-readable file sizes]
**Learning:** Hardcoding MB as the unit for file sizes (`(bytes / 1048576).toFixed(1) + " MB"`) leads to unreadable 0.0 MB for very small files and bloated numbers for multi-gigabyte files (e.g. 2560.0 MB instead of 2.5 GB), impacting UX in progress indicators and file listings.
**Action:** Created a `formatBytes` utility in `src/utils/common.js` to automatically scale byte counts into B, KB, MB, GB, etc. with appropriate precision, improving readability across the UI (`renderProgress` and `renderFilesPage`).

## 2026-04-19 - Add helpful call-to-action to empty state
**Learning:** Empty states that just say "No items" or "Empty" create a dead end for users. They don't provide guidance on how to populate the state.
**Action:** Always include a helpful call-to-action in empty states, such as "No task history. Send me a file or link to start transferring!", so users know exactly what their next step should be.
