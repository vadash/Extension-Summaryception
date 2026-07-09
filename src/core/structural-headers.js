const LINE_START_STRUCTURAL_HEADER_RE = /(^|\r?\n)[^\S\r\n]*(\[(?:NARRATIVE|STATE)\])[^\S\r\n]*/gi;
const INLINE_STATE_HEADER_RE =
    /[^\S\r\n]+(\[STATE\])[^\S\r\n]*(?=(?:[-*][^\S\r\n]*)?[a-zA-Z_][\w\s]*?\s*[:=-])/gi;

/**
 * Normalize common LLM drift where structural markers are emitted inline.
 * @param {string} text
 * @returns {string}
 */
export function normalizeStructuralHeaderLines(text) {
    return String(text || '')
        .replace(LINE_START_STRUCTURAL_HEADER_RE, normalizeLineStartHeader)
        .replace(INLINE_STATE_HEADER_RE, '\n[STATE]\n');
}

function normalizeLineStartHeader(...args) {
    const [match, _prefix, marker, offset, source] = args;
    const prefix = match.match(/^\r?\n/)?.[0] || '';
    const after = source.slice(offset + match.length);
    const needsTrailingNewline = after.length > 0 && !/^\r?\n/.test(after);
    return `${prefix}${marker.toUpperCase()}${needsTrailingNewline ? '\n' : ''}`;
}
