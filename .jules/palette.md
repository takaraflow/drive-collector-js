## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-07-21 - Add clear CTAs to bot UI empty states
**Learning:** Conversational bot empty states often leave users stuck because standard UI cues (like buttons) aren't present. Generic status statements without actionable guidance are poor UX.
**Action:** Always include clear, context-specific Call-To-Actions (CTAs) in text-based empty states (e.g., "您可以发送文件或链接来创建新任务") to guide users on their immediate next steps.
