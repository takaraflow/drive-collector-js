## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2026-06-26 - Add clear CTAs to conversational bot empty states
**Learning:** Conversational bot UI empty states without clear call-to-actions (CTAs) leave users unsure of next steps, making the interaction feel abrupt or unhelpful.
**Action:** Always include clear, context-specific CTAs in localization files (e.g. 'You can send a file or link to start') rather than generic 'No tasks' statements.
