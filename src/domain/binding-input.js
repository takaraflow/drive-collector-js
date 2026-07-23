/**
 * Shared helpers for Telegram drive-binding text inputs.
 * Telegram cannot send empty messages, so optional steps use explicit skip tokens.
 */

const SKIP_INPUTS = new Set([
    '-',
    '--',
    'skip',
    '/skip',
    'none',
    'n/a',
    'na',
    'null',
    '跳过',
    '无',
    '没有',
    '不用',
    '不需要'
]);

const BOOLEAN_TRUE_INPUTS = new Set(['1', 'true', 'yes', 'y', 'on', '是', '有', '开启', '开']);
const BOOLEAN_FALSE_INPUTS = new Set(['0', 'false', 'no', 'n', 'off', '否', '无', '关闭', '关']);

/**
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeBindingText(input) {
    return String(input ?? '').trim();
}

/**
 * @param {unknown} input
 * @returns {boolean}
 */
export function isSkipInput(input) {
    const normalized = normalizeBindingText(input).toLowerCase();
    if (!normalized) return true;
    return SKIP_INPUTS.has(normalized);
}

/**
 * Optional binding fields treat skip tokens / empty as "not provided".
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeOptionalBindingInput(input) {
    if (isSkipInput(input)) return '';
    return normalizeBindingText(input);
}

/**
 * @param {unknown} input
 * @returns {{valid: true, value: boolean} | {valid: false}}
 */
export function parseBooleanInput(input) {
    const normalized = normalizeBindingText(input).toLowerCase();
    if (BOOLEAN_TRUE_INPUTS.has(normalized)) {
        return { valid: true, value: true };
    }
    if (BOOLEAN_FALSE_INPUTS.has(normalized)) {
        return { valid: true, value: false };
    }
    return { valid: false };
}

/**
 * Heuristic for sensitive binding step names when a step does not declare sensitivity.
 * @param {string} stepName
 * @returns {boolean}
 */
export function isSensitiveBindingStepName(stepName = '') {
    const name = String(stepName || '');
    // Choice steps like WAIT_USE_2FA are not secret-bearing inputs.
    if (/USE_2FA|HAS_2FA|ENABLE_2FA/i.test(name)) {
        return false;
    }
    return /(^|_)(PASS|PASSWORD|TOKEN|SECRET|SK|2FA|OTP|CODE|KEY)(_|$)/i.test(name);
}

export {
    SKIP_INPUTS,
    BOOLEAN_TRUE_INPUTS,
    BOOLEAN_FALSE_INPUTS
};
