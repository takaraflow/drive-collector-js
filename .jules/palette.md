## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2024-06-03 - Add call-to-action to conversational bot UI empty states
**Learning:** Conversational bot UI empty states without clear call-to-actions leave users wondering what to do next, creating friction in task initiation.
**Action:** Always include clear, context-specific call-to-actions (CTAs) in empty states to explicitly guide the user on the next steps they should take.
