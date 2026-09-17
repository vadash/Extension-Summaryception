const LINE_START_STRUCTURAL_HEADER_RE = /(^|\r?\n)[^\S\r\n]*(\[(?:NARRATIVE|STATE)\])[^\S\r\n]*/gi;
const INLINE_STATE_HEADER_RE =
    /[^\S\r\n]+(\[STATE\])[^\S\r\n]*(?=(?:[-*][^\S\r\n]*)?[a-zA-Z_][\w\s]*?\s*[:=-])/gi;

// Full-line [STATE] header: the whole line is the marker, with leading and
// trailing whitespace tolerated. Splits state from narrative in parseSnippet
// and the L0 structure validators.
export const STATE_HEADER_RE = /^\s*\[STATE\]\s*$/i;
// Full-line [NARRATIVE] header: the whole line is the marker. Locates the
// narrative section in the L0 size guard; paired with STATE_HEADER_RE.
export const NARRATIVE_HEADER_RE = /^\s*\[NARRATIVE\]\s*$/i;
// Leading [NARRATIVE] header: anchored to text start only, so prose may
// follow on the same line. For stripping the header off stored narrative
// prose.
export const LEADING_NARRATIVE_HEADER_RE = /^\s*\[NARRATIVE\]\s*/i;
// Leading [STATE] header: anchored to text start only, so the state body may
// follow on the same line. Unwraps a serialized [STATE] block.
export const LEADING_STATE_HEADER_RE = /^\s*\[STATE\]\s*/i;
// Full-line [NARRATIVE] header lines across a whole document. Only for
// .replace stripping. Never use with .test because the g flag makes the
// regex stateful.
export const NARRATIVE_HEADER_LINES_RE = /^\s*\[NARRATIVE\]\s*$/gim;
// Full-line [STATE] header lines across a whole document. Only for
// .replace stripping. Never use with .test because the g flag makes the
// regex stateful. Must run after NARRATIVE_HEADER_LINES_RE because its ^\s*
// absorbs the newlines that the NARRATIVE pass leaves behind.
export const STATE_HEADER_LINES_RE = /^\s*\[STATE\]\s*$/gim;

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
