
## 2024-05-18 - [Add human-readable file sizes]
**Learning:** Hardcoding MB as the unit for file sizes (`(bytes / 1048576).toFixed(1) + " MB"`) leads to unreadable 0.0 MB for very small files and bloated numbers for multi-gigabyte files (e.g. 2560.0 MB instead of 2.5 GB), impacting UX in progress indicators and file listings.
**Action:** Created a `formatBytes` utility in `src/utils/common.js` to automatically scale byte counts into B, KB, MB, GB, etc. with appropriate precision, improving readability across the UI (`renderProgress` and `renderFilesPage`).

## 2024-05-19 - [Actionable Empty States in Conversational UI]
**Learning:** In a conversational bot environment (like Telegram), simply stating "Directory empty" or "No tasks" can leave users feeling stuck. Empty states without a Call-to-Action (CTA) are a dead-end, whereas a conversational interface should actively guide the user on the primary action they can take.
**Action:** When creating or updating empty states for conversational UIs, always include an explicit, actionable prompt (e.g., "Send me a file or link to start"). I added these prompts to `dir_empty_or_loading` and `no_tasks` in `src/locales/zh-CN.js`.
