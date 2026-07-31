## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-07-31 - Improve bot empty states with clear CTAs
**Learning:** Generic text empty states in conversational interfaces leave users without clear next steps, disrupting the user journey.
**Action:** Always append context-specific call-to-actions to empty states (e.g., explicitly instructing users to send files or use specific commands) to maintain flow and guidance.
