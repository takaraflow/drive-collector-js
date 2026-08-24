## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-08-02 - Add clear CTAs to conversational bot UI empty states
**Learning:** Users can feel stuck when encountering empty states in conversational bot interfaces (like task queues or unbind menus) without explicit next steps.
**Action:** Always include clear, context-specific call-to-actions (CTAs) in bot UI empty states, explicitly guiding the user on the next steps to take rather than just stating that there is no data.
## 2026-08-24 - [Empty States Need Explicit CTA for Buttons]
**Learning:** Even when buttons are present below an empty state message (like `no_drive_found`), users may not instinctively know they are supposed to click them unless the message text explicitly directs them to do so (e.g. "click the button below to start").
**Action:** Always include explicit, actionable CTA text in empty state messages that reference the corresponding UI buttons, instead of relying purely on the presence of the buttons.
