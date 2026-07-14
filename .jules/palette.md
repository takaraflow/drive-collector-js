## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-07-14 - Add explicit CTAs to bot empty states
**Learning:** In text-based Telegram bot UIs, generic empty states like "No active tasks" leave users unsure of what to do next, degrading the conversational flow.
**Action:** Always include clear, actionable Call-to-Actions (CTAs) (e.g., "Please send a file or link to begin") within empty state messages to guide user interaction.
