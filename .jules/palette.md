## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2026-07-26 - Add CTA to empty state in status command
**Learning:** Empty states in conversational UIs shouldn't just be informative generic statements (like "No active tasks"). They must act as dead-end resolvers.
**Action:** Always include clear, context-specific Call-To-Actions (CTAs) in empty state strings explicitly guiding the user on what to do next (e.g., "Send a file or link to start").
