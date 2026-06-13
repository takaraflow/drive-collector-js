## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-06-13 - Add clear call-to-actions to empty states
**Learning:** Conversational bot UI empty states (like 'no active tasks') without clear call-to-actions leave users guessing their next steps, whereas context-specific guidance improves the overall user experience.
**Action:** Always include clear, context-specific call-to-actions (CTAs) in UI empty states rather than generic statements, explicitly guiding the user on the next steps to take.
