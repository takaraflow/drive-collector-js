## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-07-08 - Add clear Call-To-Action to conversational empty states
**Learning:** Text-based bot interfaces often rely on generic empty states ("No active tasks") that leave users unsure of their next step. In conversational bot UIs, standard HTML accessibility and focus UIs don't apply, making text clarity paramount.
**Action:** Always append explicit, context-specific Call-To-Actions (e.g., "Send a file or link to start") to purely informational empty state messages in text bots.
