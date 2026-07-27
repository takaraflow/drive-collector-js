## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-07-27 - Add clear CTA to empty task list state
**Learning:** In a conversational UI without standard navigation menus, empty states that simply report "no tasks" can leave users stranded. Users need explicit instructions on what actions are available next.
**Action:** Always include actionable Call-To-Action (CTA) prompts within empty states to guide users towards the primary functions of the bot.
