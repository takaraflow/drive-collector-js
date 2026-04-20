
## 2024-05-18 - [Add human-readable file sizes]
**Learning:** Hardcoding MB as the unit for file sizes (`(bytes / 1048576).toFixed(1) + " MB"`) leads to unreadable 0.0 MB for very small files and bloated numbers for multi-gigabyte files (e.g. 2560.0 MB instead of 2.5 GB), impacting UX in progress indicators and file listings.
**Action:** Created a `formatBytes` utility in `src/utils/common.js` to automatically scale byte counts into B, KB, MB, GB, etc. with appropriate precision, improving readability across the UI (`renderProgress` and `renderFilesPage`).
## 2024-05-24 - Actionable Empty States
**Learning:** Empty states in conversational bots (like Telegram) shouldn’t just tell the user there is "no data" or "empty directory". They should contain a clear call-to-action or instructions on how to populate the data. Specifically, telling users they can "send files directly" is a critical UX improvement. This applies to both file listings and task batch monitoring states.
**Action:** When adding or modifying empty states for any conversational interface or dashboard, ensure a helpful call-to-action (CTA) or tip is always included to guide the user on their next possible action.
