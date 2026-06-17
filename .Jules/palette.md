
## 2024-05-18 - [Add human-readable file sizes]
**Learning:** Hardcoding MB as the unit for file sizes (`(bytes / 1048576).toFixed(1) + " MB"`) leads to unreadable 0.0 MB for very small files and bloated numbers for multi-gigabyte files (e.g. 2560.0 MB instead of 2.5 GB), impacting UX in progress indicators and file listings.
**Action:** Created a `formatBytes` utility in `src/utils/common.js` to automatically scale byte counts into B, KB, MB, GB, etc. with appropriate precision, improving readability across the UI (`renderProgress` and `renderFilesPage`).
## 2026-04-28 - Improve Empty State UX with Actionable CTAs
**Learning:** Conversational bot UI empty states (like 'no tasks' or 'empty directory') must include clear, context-specific call-to-actions (CTAs) instead of reusing generalized strings, guiding the user on what to do next.
**Action:** Always provide specific, actionable instructions in empty states rather than just stating there is no data, avoiding the reuse of generic messages across different contexts.
## 2025-02-18 - Improve File List Readability with Specific Icons
**Learning:** In text-based file explorers (like Telegram bots), users heavily rely on visual anchors. Grouping a wider variety of file extensions with distinct emojis (especially adding audio `🎵` and expanding video `🎞️`/image `🖼️`/document `📝` formats) significantly speeds up scannability compared to using a generic file emoji for unrecognized common formats.
**Action:** Always provide comprehensive type-to-icon mappings in list views, rather than just covering a few common extensions and defaulting the rest.
