## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2026-06-07 - Add CTA to empty state in task queue
**Learning:** In conversational bot interfaces, an empty state (like "no active tasks") without guidance can leave users confused about what to do next. Providing an explicit Call-To-Action (CTA) within the empty state resolves this ambiguity.
**Action:** Always include clear, context-specific CTAs in empty states for conversational UIs, instead of just displaying generic informative statements.
