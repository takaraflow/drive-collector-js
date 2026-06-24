## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2026-06-24 - Enhance empty states with clear CTAs
**Learning:** Conversational bot UI empty states must include clear, context-specific call-to-actions (CTAs) rather than generic statements, explicitly guiding the user on the next steps to take.
**Action:** Always provide explicit, actionable guidance in empty states, telling the user exactly what to do next.
