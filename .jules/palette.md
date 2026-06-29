## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-06-29 - Add CTA to empty active tasks state
**Learning:** Conversational bot UI empty states without a clear call-to-action (CTA) leave users confused about what to do next. Generic statements like "No active tasks" are insufficient.
**Action:** Always include a context-specific CTA in empty states, explicitly guiding the user on the next steps (e.g., "Send a file or link to start a new task").
