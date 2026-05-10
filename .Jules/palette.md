
## 2024-05-18 - [Add human-readable file sizes]
**Learning:** Hardcoding MB as the unit for file sizes (`(bytes / 1048576).toFixed(1) + " MB"`) leads to unreadable 0.0 MB for very small files and bloated numbers for multi-gigabyte files (e.g. 2560.0 MB instead of 2.5 GB), impacting UX in progress indicators and file listings.
**Action:** Created a `formatBytes` utility in `src/utils/common.js` to automatically scale byte counts into B, KB, MB, GB, etc. with appropriate precision, improving readability across the UI (`renderProgress` and `renderFilesPage`).
## 2026-04-28 - Improve Empty State UX with Actionable CTAs
**Learning:** Conversational bot UI empty states (like 'no tasks' or 'empty directory') must include clear, context-specific call-to-actions (CTAs) instead of reusing generalized strings, guiding the user on what to do next.
**Action:** Always provide specific, actionable instructions in empty states rather than just stating there is no data, avoiding the reuse of generic messages across different contexts.
## 2026-05-10 - Improve Task Queue and Batch Empty State UX with Actionable CTAs
**Learning:** Conversational bot UI empty states in the task queue and batch progress monitors lacked clear call-to-actions, leaving users without guidance on how to populate the queue or monitor list.
**Action:** Always provide specific, actionable instructions in empty states (e.g. "请发送文件或链接来创建新任务。" or "请尝试点击下方按钮查看其他状态。") to guide users towards next steps instead of just stating that there's no data.
