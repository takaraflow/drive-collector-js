## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-05-26 - Add Call-To-Action to Conversational Empty States
**Learning:** In conversational bot UIs, generic empty states like "No active tasks" leave users unsure of what to do next, which can stall interaction.
**Action:** Always include clear, context-specific call-to-actions (CTAs) in empty state messages (e.g., "Send a file or link to create a new task") to explicitly guide the user's next steps.
