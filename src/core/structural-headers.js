const LINE_START_STRUCTURAL_HEADER_RE = /(^|\r?\n)[^\S\r\n]*(\[(?:NARRATIVE)\])[^\S\r\n]*/gi;

// Full-line [NARRATIVE] header: the whole line is the marker. Locates the
// narrative section in the L0 size guard.
export const NARRATIVE_HEADER_RE = /^\s*\[NARRATIVE\]\s*$/i;
// Leading [NARRATIVE] header: anchored to text start only, so prose may
// follow on the same line. For stripping the header off stored narrative
// prose.
export const LEADING_NARRATIVE_HEADER_RE = /^\s*\[NARRATIVE\]\s*/i;
// Full-line [NARRATIVE] header lines across a whole document. Only for
// .replace stripping. Never use with .test because the g flag makes the
// regex stateful.
export const NARRATIVE_HEADER_LINES_RE = /^\s*\[NARRATIVE\]\s*$/gim;

/**
 * Normalize common LLM drift where structural markers are emitted inline.
 * @param {string} text
 * @returns {string}
 */
export function normalizeStructuralHeaderLines(text) {
    return String(text || '').replace(LINE_START_STRUCTURAL_HEADER_RE, normalizeLineStartHeader);
}

function normalizeLineStartHeader(...args) {
    const [match, _prefix, marker, offset, source] = args;
    const prefix = match.match(/^\r?\n/)?.[0] || '';
    const after = source.slice(offset + match.length);
    const needsTrailingNewline = after.length > 0 && !/^\r?\n/.test(after);
    return `${prefix}${marker.toUpperCase()}${needsTrailingNewline ? '\n' : ''}`;
}
