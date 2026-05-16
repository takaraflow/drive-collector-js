# Product

## Register

product

## Users

Drive Collector Bot serves Telegram users who want to transfer files, videos, images, and supported links from Telegram into their own cloud storage with as little operational knowledge as possible. Users work primarily on mobile inside Telegram, often while switching between chats, and expect clear progress, recoverable errors, and short next-step actions. Administrators use the same Telegram surface to inspect queue health, diagnose runtime issues, and manage access.

## Product Purpose

The product turns Telegram into a practical file collection and cloud-transfer control surface. Success means a user can bind a drive, send media or links, understand queue/progress state, and find transferred files without learning the underlying distributed architecture. The operational system can be complex; the Telegram experience should remain calm, direct, and task-led.

## Brand Personality

Calm, capable, concise. The bot should feel like a reliable utility, not a marketing assistant. It should speak plainly, show progress when work is asynchronous, and always give the next useful action after empty, loading, success, and error states.

## Anti-references

Avoid command-manual experiences that force users to memorize syntax. Avoid exposing implementation terms such as QStash, D1, UID, MCP, 2FA workarounds, or raw database errors to ordinary users unless the user is explicitly in an administrator or developer flow. Avoid noisy emoji decoration where icons do not clarify state or action.

## Design Principles

1. Make the next action tappable whenever Telegram supports it.
2. Treat D1 task state and repository data as the UX source of truth; do not display process-local approximations as user-facing status.
3. Separate user workflows from administrator diagnostics.
4. Prefer short, recoverable messages over long command lists.
5. Preserve trust in high-stakes moments: credential input, unlinking drives, failed transfers, and token display.

## Accessibility & Inclusion

Design for mobile-first Telegram usage. Keep button rows short, avoid blank or ambiguous buttons, and do not rely on emoji alone to communicate meaning. Error messages must include a plain-language cause and a next step. Destructive actions require explicit confirmation. Sensitive token and credential flows must minimize exposure and explain risk without alarmism.
