## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2026-07-16 - Add actionable CTA to empty active tasks state
**Learning:** Empty states without explicit call-to-actions leave users wondering what to do next, particularly in text-based bot interfaces where generic feedback like "no active tasks" isn't helpful on its own.
**Action:** Always include a context-specific, actionable next step (CTA) in conversational UI empty states to explicitly guide users on how to proceed.
