## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-06-21 - Add clear CTAs to conversational bot empty states
**Learning:** Conversational bot UI empty states without call-to-actions leave users stranded, unsure of what they can do next to proceed with the primary flow.
**Action:** Always include clear, context-specific call-to-actions (CTAs) in empty state localization strings, explicitly guiding the user on the next steps to take (e.g., 'send a file or link to create a new task').
