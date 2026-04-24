
## 2024-05-18 - [Add human-readable file sizes]
**Learning:** Hardcoding MB as the unit for file sizes (`(bytes / 1048576).toFixed(1) + " MB"`) leads to unreadable 0.0 MB for very small files and bloated numbers for multi-gigabyte files (e.g. 2560.0 MB instead of 2.5 GB), impacting UX in progress indicators and file listings.
**Action:** Created a `formatBytes` utility in `src/utils/common.js` to automatically scale byte counts into B, KB, MB, GB, etc. with appropriate precision, improving readability across the UI (`renderProgress` and `renderFilesPage`).
## 2024-04-24 - Conversational Bot Empty States

**Learning:** In conversational UI bots (like Telegram bots), empty states that just declare "no data" (e.g. "尚无任务记录。") create dead ends for users. Moreover, reusing generic empty states across different contexts (like using a file list empty state for a task monitor) creates confusion. Empty states must be context-specific and actionable.
**Action:** Always include a clear Call-To-Action (CTA) in empty states that instructs the user on how to populate the data (e.g., "您可以直接发送文件或链接给我..."). Never reuse generic empty state strings across different functional domains.
