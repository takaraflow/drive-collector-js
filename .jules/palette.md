## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-06-11 - Add actionable CTAs to conversational bot empty states
**Learning:** In a conversational bot environment without traditional UI elements, users often get stuck at dead ends when encountering generic empty states without explicit instructions on how to proceed.
**Action:** Always include clear, context-specific call-to-actions (CTAs) in conversational bot empty states (e.g., advising users to send a file or link) to explicitly guide them on the next steps.
