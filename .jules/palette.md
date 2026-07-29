## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-07-29 - Added CTAs to empty states
**Learning:** In text-based Telegram bot UIs, generic empty states leave users confused about what to do next. Conversational UI needs explicit, context-aware call-to-actions (CTAs).
**Action:** Always include a clear "what to do next" instruction in empty states, utilizing bold text or emojis to distinguish the CTA from the status message.
