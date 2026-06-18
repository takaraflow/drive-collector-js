## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2026-06-08 - Add explicit CTAs to conversational empty states
**Learning:** Generic empty state messages without call-to-actions leave users confused about next steps, especially in conversational bot interfaces.
**Action:** Always include context-specific call-to-actions (CTAs) in conversational bot UI empty states (e.g., localization files) guiding the user on the next steps to take.
