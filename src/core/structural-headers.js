// Structural markers of the summarizer output contract (ADR-0015): the
// <narrative> envelope and the <declined> escape hatch.
// Legacy leading [NARRATIVE] header on snippets stored before the envelope:
// anchored to text start, so prose may follow on the same line. Read-compat
// only; new writes are enveloped.
export const LEADING_NARRATIVE_HEADER_RE = /^\s*\[NARRATIVE\]\s*/i;

const NARRATIVE_OPEN_TAG = '<narrative>';
const NARRATIVE_CLOSE_TAG = '</narrative>';

/**
 * Parse the Output Envelope: the prose between one <narrative> open tag that
 * starts the text and one close tag, plus the tail after the close tag. Input
 * is normalized for line-start tag drift first, so callers hand in raw text.
 * @param {string} text - Raw summarizer output or stored snippet text
 * @returns {{ body: string, tail: string } | null} Null without an open-anchored, single-close envelope
 */
export function parseNarrativeEnvelope(text) {
    const normalized = normalizeStructuralHeaderLines(String(text || '')).trim();
    const lower = normalized.toLowerCase();
    if (!lower.startsWith(NARRATIVE_OPEN_TAG)) {
        return null;
    }
    const closeIndex = lower.indexOf(NARRATIVE_CLOSE_TAG);
    if (closeIndex === -1) {
        return null;
    }
    return {
        body: normalized.slice(NARRATIVE_OPEN_TAG.length, closeIndex),
        tail: normalized.slice(closeIndex + NARRATIVE_CLOSE_TAG.length),
    };
} // Line-start tag drift for the envelope pair, normalized the same way
// bracket headers always were: lowercase-out, own line, one newline after.
// Legacy bracket headers arriving in model output normalize into the envelope.
const LINE_START_TAG_RE =
    /(^|\r?\n)[^\S\r\n]*(<narrative>|<\/narrative>|\[\/?.?NARRATIVE\]?)[^\S\r\n]*/gi;
const BRACKET_TAG_MAP = {
    '[NARRATIVE]': '<narrative>',
    '[/NARRATIVE]': '</narrative>',
};
// The Declined Marker is a single-line construct: <declined>reason</declined>.
// Normalized as one unit so the reason never separates from the tag pair.
const DECLINED_PAIR_RE = /(^|\r?\n)[^\S\r\n]*<declined>([\s\S]*?)<\/declined>[^\S\r\n]*/gi;

/**
 * Normalize common LLM drift where structural tags are emitted inline.
 * @param {string} text
 * @returns {string}
 */
export function normalizeStructuralHeaderLines(text) {
    return String(text || '')
        .replace(DECLINED_PAIR_RE, normalizeDeclinedPair)
        .replace(LINE_START_TAG_RE, normalizeLineStartTag);
}

function normalizeLineStartTag(...args) {
    const [match, _prefix, tag, offset, source] = args;
    const prefix = match.match(/^\r?\n/)?.[0] || '';
    const after = source.slice(offset + match.length);
    const needsTrailingNewline = after.length > 0 && !/^\r?\n/.test(after);
    const normalized = BRACKET_TAG_MAP[tag.toUpperCase()] || tag.toLowerCase();
    return `${prefix}${normalized}${needsTrailingNewline ? '\n' : ''}`;
}

function normalizeDeclinedPair(...args) {
    const [match, prefix, reason] = args;
    const lineBreak = match.match(/^\r?\n/)?.[0] || '';
    const normalized = `${lineBreak}<declined>${reason}</declined>`;
    return prefix ? normalized : normalized.replace(/^\r?\n/, '');
}
