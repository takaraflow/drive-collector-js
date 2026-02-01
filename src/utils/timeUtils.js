/**
 * Time utility for formatting dates to UTC+8 (Beijing Time)
 */

/**
 * Get current time in UTC+8 as a formatted string
 * Format: YYYY-MM-DD HH:mm:ss
 * @returns {string}
 */
export const getBeijingTimestamp = () => {
    const now = new Date();
    // Use Intl.DateTimeFormat for reliable timezone conversion
    const formatter = new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Asia/Shanghai'
    });

    const parts = formatter.formatToParts(now);
    const getPart = (type) => parts.find(p => p.type === type).value;

    return `${getPart('year')}-${getPart('month')}-${getPart('day')} ${getPart('hour')}:${getPart('minute')}:${getPart('second')}`;
};

/**
 * Get current time in UTC+8 as an ISO-like string
 * @returns {string}
 */
export const getBeijingISOString = () => {
    const now = new Date();
    const offset = 8 * 60; // UTC+8 in minutes
    const localTime = new Date(now.getTime() + (offset + now.getTimezoneOffset()) * 60000);
    return localTime.toISOString().replace('Z', '+08:00');
};
