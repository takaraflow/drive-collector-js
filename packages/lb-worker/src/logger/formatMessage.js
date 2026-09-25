import { isTestEnvironment } from './runtimeEnv.js';

const LOG_EMOJIS = {
  info: 'ℹ️',
  warn: '⚠️',
  error: '❌',
  debug: '🔍',
  success: '✅',
  start: '🚀',
  done: '🏁',
  cache: '💾',
  network: '🌐',
  auth: '🔐',
  lb: '⚖️',
  health: '🏥',
  config: '⚙️'
};

/**
 * @param {string} message
 * @param {string} level
 * @param {string} [category]
 * @returns {string}
 */
export function formatMessage(message, level, category) {
  if (isTestEnvironment) {
    const categoryTag = category ? `[${String(category).toUpperCase()}] ` : '';
    return `${categoryTag}${message}`;
  }

  let emoji = LOG_EMOJIS[level] || '';
  if (category && LOG_EMOJIS[category]) {
    emoji = LOG_EMOJIS[category];
  }

  if (/^[\u{1F300}-\u{1F9FF}]|^[\u{2600}-\u{26FF}]|^[\u{2700}-\u{27BF}]/u.test(message)) {
    return message;
  }

  const categoryTag = category ? `[${String(category).toUpperCase()}] ` : '';
  return `${emoji} ${categoryTag}${message}`.trim();
}

