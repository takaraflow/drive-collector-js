/**
 * Byte size utilities (CF Workers + Node compatible)
 */

/**
 * @param {string} str
 * @returns {number}
 */
export function getByteSize(str) {
  if (str === null || str === undefined) return 0;
  return new TextEncoder().encode(String(str)).length;
}

