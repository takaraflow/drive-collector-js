## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2026-06-04 - Add actionable CTA to empty state
**Learning:** In a conversational bot environment, generic empty states can leave users wondering what to do next. Providing actionable suggestions with direct examples of next steps significantly improves user guidance and flow.
**Action:** When updating empty state messages in a bot interface, ensure that an explicit call-to-action (CTA) detailing what the user can do to populate the system is included.
