import { trace } from '@opentelemetry/api';
import { VERSION } from './version.js';

/**
 * @param {string} level
 * @param {string} message
 * @param {Record<string, any>} data
 * @param {any} providedSpan
 */
export function addOtelEvent(level, message, data = {}, providedSpan = null) {
  try {
    const activeSpan = providedSpan || trace.getActiveSpan();
    if (!activeSpan || typeof activeSpan.addEvent !== 'function') return;
    activeSpan.addEvent('log', {
      'log.level': level,
      'log.message': message,
      'log.version': VERSION,
      'log.module': data.module || 'unknown',
      ...data
    });
  } catch {
    // ignore
  }
}

