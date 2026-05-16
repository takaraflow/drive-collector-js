# Design

## System

Drive Collector Bot is a Telegram-native product UI. It uses Telegram messages, HTML formatting, command menus, callback toasts, and inline keyboard rows as its design system. The visual layer must be dense enough for chat, but structured enough that users can scan state and act without reading a manual.

## Surfaces

- User onboarding: `/start`, unknown text fallback, and no-drive states.
- Drive management: `/drive`, drive type selection, credential prompts, default-drive selection, and unlink confirmation.
- Transfer state: captured task messages, queue/progress monitors, completion, duplicates, failures, retry, and cancel controls.
- Browsing: `/files` listing, refresh, pagination, empty directory state.
- Status: `/status`, `/status queue`, `/status user`.
- Settings: `/remote_folder` and `/set_remote_folder`.
- Administrator tools: `/task_queue`, `/diagnosis`, access mode, ban/unban, admin role changes.

## Message Structure

Use this order for user-facing messages:

1. One-line title with state icon and bold label.
2. Essential context in one or two short lines.
3. Optional compact details in `<code>` only when users need to copy or inspect them.
4. Next action through inline buttons whenever possible.

Avoid long command catalogs in ordinary flows. Put advanced commands behind `/help` or administrator-only surfaces.

## Buttons

Use inline buttons as primary affordances. Keep rows to one or two buttons unless they are compact pagination controls. Do not use blank labels for disabled buttons. Disabled navigation should be omitted or replaced by a clear page indicator. Destructive actions use a confirm/cancel row. Recovery states should offer a direct retry or return action.

## Copy

Tone is calm, capable, concise. Prefer verbs and concrete outcomes:

- "绑定网盘" over "请选择服务开始绑定" when the button can do it.
- "重新加载文件列表" over "稍后重试" when retry is available.
- "当前暂不支持开启两步验证的账号" over "请先关闭 2FA".

Ordinary users should see "我的任务" and "上传路径", not implementation terms. Administrator surfaces may use more technical labels but should still explain failures in plain language.

## State Vocabulary

- Empty: explain what will appear here and provide the next action.
- Loading: say what is happening, then edit the same message with the result.
- Success: confirm the completed action and show where to go next.
- Warning: describe the constraint and safe next action.
- Error: plain-language cause, recovery action, and when needed a contact-admin fallback.

## Accessibility

Emoji can reinforce state but cannot be the only label. File names and paths are escaped and shortened where needed. Touch targets should be descriptive and stable. Repeated button patterns should stay consistent across files, task queue, and settings.
