## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-07-11 - Add CTA to empty queue state
**Learning:** Empty states in conversational bot UI (like empty task queues) feel dead and unhelpful when they just report the status without guiding the user on what to do next.
**Action:** Always include a clear context-specific call-to-action (CTA) in empty states, telling the user what actions they can take to populate the state or what to do next.
