
## 2024-05-18 - [Add human-readable file sizes]
**Learning:** Hardcoding MB as the unit for file sizes (`(bytes / 1048576).toFixed(1) + " MB"`) leads to unreadable 0.0 MB for very small files and bloated numbers for multi-gigabyte files (e.g. 2560.0 MB instead of 2.5 GB), impacting UX in progress indicators and file listings.
**Action:** Created a `formatBytes` utility in `src/utils/common.js` to automatically scale byte counts into B, KB, MB, GB, etc. with appropriate precision, improving readability across the UI (`renderProgress` and `renderFilesPage`).

## 2024-05-19 - [Add CTAs to empty states]
**Learning:** Conversational bot empty states without clear call-to-actions (e.g. "Directory is empty" or "No tasks") leave the user wondering what to do next. Contextual CTAs significantly improve the user experience.
**Action:** Always include actionable hints in empty state text, specifically tailored to the feature's context (e.g. "Send files or links to start"). Avoid reusing generalized empty state strings across contexts to maintain specific relevance.
