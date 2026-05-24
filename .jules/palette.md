## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2026-05-24 - Add CTA to empty state
**Learning:** In conversational bot UIs, generic empty states like 'No active tasks' leave users wondering what to do next, leading to a dead-end experience.
**Action:** Always include a context-specific Call-to-Action (CTA) in empty state messages, explicitly guiding the user on the next steps (e.g., 'Send a file or link to start').
