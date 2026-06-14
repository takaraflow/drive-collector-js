## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-06-14 - Add call-to-action to conversational bot empty states
**Learning:** Conversational bot UI empty states that only report the absence of items (e.g., "No active tasks") leave users without clear next steps, breaking the interaction flow in chat interfaces.
**Action:** Always include clear, context-specific call-to-actions (CTAs) in conversational bot UI empty states, explicitly guiding the user on the next steps to take (e.g., "You can send a file or link to start a transfer").
