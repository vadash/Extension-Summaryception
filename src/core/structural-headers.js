// Structural markers of the summarizer output contract (ADR-0015): the
// <narrative> envelope and the <declined> escape hatch.
// Legacy leading [NARRATIVE] header on snippets stored before the envelope:
// anchored to text start, so prose may follow on the same line. Read-compat
// only; new writes are enveloped.
export const LEADING_NARRATIVE_HEADER_RE = /^\s*\[NARRATIVE\]\s*/i;

const NARRATIVE_OPEN_TAG = '<narrative>';
const NARRATIVE_CLOSE_TAG = '</narrative>';

/**
 * Input is normalized for line-start tag drift first, so callers hand in raw
 * text.
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
}

// Exactly one leading reasoning region, written as a tag pair whose name is
// the model-facing marker. A model that leaks its reasoning step before the
// envelope still produced a valid answer, so the region is removed before
// validation instead of failing the call (ADR-0033). Closed first, then an
// unclosed region running to the envelope open. Built from parts so the tag
// spelling lives in one place.
const THINK_OPEN = '<' + 'think' + '>';
const THINK_CLOSE = '<' + '/think' + '>';
const LEADING_THINK_CLOSED_RE = new RegExp(
    `^\\s*${THINK_OPEN}([\\s\\S]*?)${THINK_CLOSE}[^\\S\\r\\n]*\\r?\\n?`,
    'i',
);
const LEADING_THINK_UNCLOSED_RE = new RegExp(`^\\s*${THINK_OPEN}[\\s\\S]*?(?=<narrative>)`, 'i');

/**
 * Strip at most one leading reasoning region from a raw model response.
 *
 * A region whose content reaches a second open tag is not a clean leading
 * region: stripping it would swallow the envelope, so the text is returned
 * untouched and the normal reject path applies.
 * @param {string} text - Raw summarizer output
 * @returns {{ text: string, stripped: boolean }}
 */
export function stripLeadingThinkRegion(text) {
    const source = String(text ?? '');
    const closed = LEADING_THINK_CLOSED_RE.exec(source);
    if (closed) {
        if (closed[1].toLowerCase().includes(THINK_OPEN.toLowerCase())) {
            return { text: source, stripped: false };
        }
        return { text: source.slice(closed[0].length), stripped: true };
    }
    const unclosed = LEADING_THINK_UNCLOSED_RE.exec(source);
    if (unclosed) {
        return { text: source.slice(unclosed[0].length), stripped: true };
    }
    return { text: source, stripped: false };
}

/** The model-facing tag names this module owns, for callers building text. */
export const REASONING_TAG = Object.freeze({ open: THINK_OPEN, close: THINK_CLOSE });

// Line-start tag drift for the envelope pair, normalized the same way
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
