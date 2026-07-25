## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-07-25 - Add actionable CTA to bot UI empty states
**Learning:** Conversational bot interfaces with generic empty states (e.g., "No active tasks") leave users without clear guidance on what to do next, which can break the conversational flow.
**Action:** Always include context-specific call-to-actions (CTAs) in empty state messages (e.g., "Send a file or link to start") to explicitly guide the user on the next steps.
