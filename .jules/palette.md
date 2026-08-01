## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-08-01 - Added CTA to Empty States
**Learning:** Conversational bot UI empty states must include explicit call-to-actions to guide the user's next steps, rather than just displaying generic statements.
**Action:** Always verify that empty states in localization files include actionable guidance (e.g., instructing users to send files or links).
