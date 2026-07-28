## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-07-28 - Add actionable CTA to empty states in bot UI
**Learning:** In conversational bot interfaces, generic empty states without next steps leave users confused about how to proceed. Standard web UX rules don't apply here; text clarity and context-specific CTAs are the primary UX drivers.
**Action:** Always append clear, context-specific call-to-actions (like "You can directly send files or links to start") to empty states in localization files to guide users.
