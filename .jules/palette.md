## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-06-11 - Add clear Call-to-Action to empty states in conversational UI
**Learning:** Conversational bot UI empty states (like "✅ 当前没有排队或处理中任务。") without clear next steps leave users guessing what to do next, increasing friction in the user experience.
**Action:** Always include clear, context-specific call-to-actions (CTAs) in empty state localization messages (e.g., guiding users to send a file or link to start a transfer) to explicitly guide the user.
