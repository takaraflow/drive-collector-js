## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-06-12 - Add CTAs to Conversational Bot Empty States
**Learning:** Users can feel stuck when presented with a simple statement of emptiness in a bot interface (e.g., 'No active tasks'). Without inline UI elements like buttons in traditional web apps, text-based empty states must carry the burden of instruction.
**Action:** Always append clear, actionable text (e.g., 'Send a file or link to start') to empty state messages in bot localization files so users immediately know their next move.
