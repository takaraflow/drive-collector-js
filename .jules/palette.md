## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2026-06-16 - Empty State Improvements in Bot Responses
**Learning:** Conversational bot interfaces can feel like dead-ends when they simply report "no tasks" without giving the user the next logical step.
**Action:** Always include a clear Call-To-Action (CTA) in empty state messages, guiding the user on how to populate the state (e.g., "You can send a file or link to start transferring").
