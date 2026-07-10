## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2026-07-10 - Add CTAs to Empty States in Bot UI
**Learning:** In conversational interfaces (like a Telegram bot), generic empty states (e.g., "no active tasks") leave the user stuck. Without clear visual UI buttons everywhere, textual context must always provide the exact next actionable step.
**Action:** Always include a clear Call-to-Action (CTA) instructing the user on what to send or type next in all conversational empty states (e.g., "Send me a file to start" instead of just "No files").
