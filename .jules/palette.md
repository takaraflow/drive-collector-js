## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2024-05-24 - Improve empty state guidance
**Learning:** Empty states with generic statements leave users without clear direction on what to do next.
**Action:** Always include clear, context-specific call-to-actions (CTAs) in conversational bot UI empty states, explicitly guiding the user on the next steps to take.
