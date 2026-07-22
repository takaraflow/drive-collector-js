## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-07-22 - Add CTAs to bot UI empty states
**Learning:** In text-based bot interfaces, empty states like "No active tasks" can be dead ends. Adding clear Call-To-Actions (CTAs) within the empty state text significantly improves usability and helps users know what they can do next.
**Action:** Always append actionable next steps (like "You can send a file or link to start") to bot text UI empty state messages.
