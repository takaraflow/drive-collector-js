## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-07-12 - Add actionable CTA to empty states
**Learning:** In text-based conversational bot interfaces, generic empty states (like "No active tasks") leave users without a clear path forward, causing friction.
**Action:** Always include a context-specific Call-To-Action (CTA) in conversational UI empty states, explicitly guiding the user on what to send next.
