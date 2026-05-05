## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.

## 2026-05-06 - Actionable CTAs in Empty States
**Learning:** Empty states in conversational bots (like Telegram) are critical touchpoints. Simply stating "no data" leaves users confused about what to do next, especially for feature discoverability like batch tasks.
**Action:** Always provide clear, direct instructions (Call to Actions) in empty states that tell the user exactly what commands or actions they need to take to populate the state.
