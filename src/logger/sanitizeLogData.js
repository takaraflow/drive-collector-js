/**
 * Data sanitization (Axiom safeguard)
 * - Limit object depth
 * - Limit string length
 * - Limit field count
 */

/**
 * @param {any} val
 * @param {number} depth
 * @param {{fieldCount:number}} context
 * @returns {any}
 */
export function sanitizeLogData(val, depth = 0, context = { fieldCount: 0 }) {
  try {
    if (depth > 4) {
      return '[DEPTH_EXCEEDED]';
    }

    if (val === null || val === undefined) {
      return val;
    }

    if (typeof val === 'string') {
      if (val.length > 10000) {
        return val.substring(0, 10000) + '...[TRUNCATED]';
      }
      return val;
    }

    if (typeof val !== 'object') {
      return val;
    }

    if (Array.isArray(val)) {
      return val.map((item) => sanitizeLogData(item, depth + 1, context));
    }

    if (val instanceof Date) {
      return val.toISOString();
    }

    const cleaned = {};

    const priorityKeys = ['timestamp', 'level', 'message', 'requestId'];
    const priorityData = {};
    const otherData = {};

    for (const key in val) {
      if (priorityKeys.includes(key)) {
        priorityData[key] = val[key];
      } else {
        otherData[key] = val[key];
      }
    }

    for (const key in priorityData) {
      cleaned[key] = sanitizeLogData(priorityData[key], depth + 1, context);
    }

    let fieldCount = 0;
    for (const key in otherData) {
      if (fieldCount >= 50) {
        cleaned._truncated_fields = true;
        break;
      }
      cleaned[key] = sanitizeLogData(otherData[key], depth + 1, context);
      fieldCount++;
    }

    return cleaned;
  } catch {
    return '[SANITATION_ERROR]';
  }
}

