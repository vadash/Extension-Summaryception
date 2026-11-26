const CHINESE_IDEOGRAPH_REGEX = /\p{Script=Han}/gu;
const HORIZONTAL_WHITESPACE_RUN_REGEX = /[^\S\r\n]+/g;

/**
 * Count Han ideographs in text.
 * @param {string} text
 * @returns {number}
 */
export function countChineseIdeographs(text) {
    return String(text || '').match(CHINESE_IDEOGRAPH_REGEX)?.length || 0;
}

/**
 * Replace Han ideographs with spaces and collapse horizontal whitespace while
 * preserving line breaks.
 * @param {string} text
 * @returns {string}
 */
export function stripChineseIdeographs(text) {
    return String(text || '')
        .replace(CHINESE_IDEOGRAPH_REGEX, ' ')
        .replace(HORIZONTAL_WHITESPACE_RUN_REGEX, ' ');
}
