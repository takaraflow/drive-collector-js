## 2026-04-19 - Add context size to progress bar in batch monitor
**Learning:** During long tasks, displaying only a percentage without absolute sizes makes it hard for users to estimate file transfers and completion times, leading to anxiety during large transfers where percentages update slowly.
**Action:** Always include absolute transfer metrics (e.g. current bytes / total bytes) formatted in a human-readable way alongside percentages in CLI or text-based progress bars.
## 2026-05-30 - Improve empty states with clear CTAs
**Learning:** Conversational bot UI empty states (e.g., in localization files like src/locales/zh-CN.js) often contain generic statements like '目前尚未绑定任何网盘。请选择下方服务开始绑定：' or '当前没有排队或处理中任务。' which leaves users unsure of what to do next.
**Action:** Update empty states to include clear, context-specific call-to-actions (CTAs), explicitly guiding the user on the next steps to take, such as '您可以使用下方按钮绑定网盘后，向我发送文件来进行转存：' or '您可以直接向我发送文件、图片或链接来开始转存。'
