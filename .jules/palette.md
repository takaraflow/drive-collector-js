## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2026-07-09 - Add context-specific Call-to-Action to empty state
**Learning:** Conversational bot interfaces lack standard UI discovery mechanisms (like menus or visible buttons), making empty states without clear Call-to-Actions confusing as users don't know what they can do next.
**Action:** Always append context-specific Call-to-Actions to conversational bot empty states, explicitly guiding users on exactly what input or commands the bot expects next.
