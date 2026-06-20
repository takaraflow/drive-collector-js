## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2024-05-20 - Empty State CTAs
**Learning:** Conversational bot UI empty states must include clear, context-specific call-to-actions (CTAs) rather than generic statements.
**Action:** Always append actionable guidance to empty states.
