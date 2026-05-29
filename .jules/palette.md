## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2024-05-29 - Empty States Need Actionable CTAs
**Learning:** In a conversational bot UI, empty states (like "no active tasks" or "no drive found") that only report the status can leave users stuck. They must include clear, context-specific call-to-actions (CTAs) guiding the user on the exact next steps.
**Action:** Always append actionable commands (e.g., "Send /drive to bind") or instructions (e.g., "Send a file to start") to empty state messages rather than leaving them generic.
