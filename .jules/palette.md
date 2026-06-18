## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2025-05-19 - Actionable empty states in Bot UIs
**Learning:** Conversational bot UI empty states often leave users stranded if they only state the current condition without guidance.
**Action:** Always include clear, context-specific call-to-actions (CTAs) in empty state messages, explicitly guiding the user on the next steps to take.
