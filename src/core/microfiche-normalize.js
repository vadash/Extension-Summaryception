// Microfiche glyph normalization: renderer-blind text folding for Canvas2D
// fillText. String transforms only, no host or canvas access.

/**
 * @typedef {object} MicroficheNormalizeOptions
 * @property {'5x8' | '8x8' | '6x12' | '8x13' | 'silver'} [font] - Bitmap cell
 * family hint; reserved for font-aware coverage checks, ASCII behavior today.
 */

/**
 * @typedef {object} MicroficheRenderability
 * @property {boolean} isSafe - true when at most 5% of graphics hit '?'.
 * @property {number} unrenderableRatio - Fallback share of graphic characters.
 */

/**
 * Zero-width ink toggles: text between them prints dim without a cell.
 * Facts shared with the reader path, so dim spans survive pagination.
 * @type {string}
 */
export const DIM_ON = '\u000e';

/**
 * Zero-width ink toggle closing a dim span.
 * @type {string}
 */
export const DIM_OFF = '\u000f';

/**
 * Printed for newline runs so line structure survives whitespace collapsing.
 * @type {string}
 */
export const NEWLINE_GLYPH = '█';

// Quotation marks, dashes, bullets, arrows, and dot leaders without a
// printable ASCII decomposition.
const CHAR_FOLD = {
    '‘': "'",
    '’': "'",
    '‚': "'",
    '‛': "'",
    '“': '"',
    '”': '"',
    '„': '"',
    '′': "'",
    '″': '"',
    '‵': "'",
    '‶': '"',
    '‹': '<',
    '›': '>',
    '‐': '-',
    '‑': '-',
    '‒': '-',
    '–': '-',
    '—': '-',
    '―': '-',
    '−': '-',
    '⁄': '/',
    '․': '.',
    '‥': '..',
    '…': '...',
    '⋯': '...',
    '•': '*',
    '‣': '*',
    '⁃': '-',
    '∙': '*',
    '●': '*',
    '■': '*',
    '▪': '*',
    '←': '<-',
    '↑': '^',
    '→': '->',
    '↓': 'v',
    '↔': '<->',
    '⇐': '<=',
    '⇒': '=>',
    '⇔': '<=>',
    '✓': 'v',
    '✔': 'v',
    '✗': 'x',
    '✘': 'x',
};

// Status pictographs that carry tool-output meaning; other pictographs drop.
const EMOJI_FOLD = {
    '✅': '[OK]',
    '☑': '[OK]',
    '✔': '[OK]',
    '❌': '[FAIL]',
    '❎': '[FAIL]',
    '✖': '[FAIL]',
    '⚠': '[WARN]',
    '🚨': '[ALERT]',
    ℹ: '[INFO]',
    '🐛': '[BUG]',
    '💥': '[CRASH]',
    '🔥': '[HOT]',
    '🔒': '[LOCK]',
    '🔓': '[UNLOCK]',
    '📁': '[DIR]',
    '📂': '[DIR]',
    '📄': '[FILE]',
    '📝': '[NOTE]',
    '🧪': '[TEST]',
    '⏳': '[WAIT]',
    '⌛': '[WAIT]',
    '🚀': '[RUN]',
};

// Escape, C1, and CSI tails leave no glyph, so one pass strips them all.
// Built from a string so no literal control byte lands in a regex class.
const ANSI_RE = new RegExp(
    `${'\\u001b'}\\[[0-9;?]*[ -/]*[@-~]|${'\\u001b'}[()][0-9A-B]|[${'\\u001b\\u009b\\u009d\\u009f'}].*?([${'\\u0007'}]|${'\\u001b'}${'\\\\'})`,
    'g',
);

// Whitespace plus format chars fold in one run; genuine line breaks become the glyph.
const COLLAPSIBLE = /[\s\p{Cf}]+/gu;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
// Leading and trailing blanks or glyphs add no frame content.
const EDGE_RUNS = /^[ █]+|[ █]+$/g;
// Combining marks NFKD splits off accented letters; dropped so the base prints.
const COMBINING_MARKS = /\p{M}+/gu;
const UNRENDERABLE = /[\p{Cc}\p{Mn}\p{Me}\p{Cs}]/u;
const EMOJI_PICTOGRAPH = /\p{Extended_Pictographic}/u;

// High-frequency function words the reader reconstructs from context.
const STOPWORDS = new Set(
    (
        'the a an and or of to in on at as is are was were be been by for with that this it its from had has have not but ' +
        'he she his her they their them which also who whom when where while will would could should there then than ' +
        'into over under about after before between during each such these those some most more other only same so'
    ).split(' '),
);

// Maximal letter runs use the bitmap fonts' ASCII and Latin-1 coverage.
const ALPHA_RUN = /[a-zA-ZÀ-ÖØ-öø-ÿ]+/g;
// Splitter keeps the zero-width toggles as their own segments. Built from
// strings so no literal control byte lands in a regex class.
const DIM_MARKER_SPLIT = new RegExp(`(${'\\u000e'}|${'\\u000f'})`);
// Canvas2D draws every script, so narrow letters, numbers, and marks stay
// printable; wide glyphs keep the '?' fold because the grid lays them out in
// two cells while fillText advances one, and symbols without a fold entry
// fall back to '?'.
const SCRIPT_PRINTABLE = /[\p{L}\p{N}\p{M}]/u;
// East Asian wide/fullwidth ranges, mirrored from microfiche-geometry.js so
// normalize stays host-free with no module cycle.
const WIDE_RANGES = [
    [0x1100, 0x115f],
    [0x2e80, 0x2eff],
    [0x2f00, 0x2fdf],
    [0x3000, 0x303e],
    [0x3041, 0x33ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xa000, 0xa4cf],
    [0xac00, 0xd7a3],
    [0xf900, 0xfaff],
    [0xfe30, 0xfe4f],
    [0xff00, 0xff60],
    [0xffe0, 0xffe6],
    [0x20000, 0x2fffd],
    [0x30000, 0x3fffd],
];
/**
 * @param {number} codePoint
 * @returns {boolean} True for the bitmap fonts' printable ASCII/Latin-1 range.
 */
function isAsciiOrLatin1(codePoint) {
    return (codePoint >= 0x20 && codePoint < 0x7f) || (codePoint >= 0xa0 && codePoint <= 0xff);
}

/**
 * @param {number} codePoint
 * @returns {boolean} True for East Asian wide/fullwidth ranges.
 */
function isWideCodePoint(codePoint) {
    return WIDE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high);
}
/**
 * Aggressive single-code-point ASCII fold via NFKD: compatibility forms
 * decompose, marks drop, and the ASCII/Latin-1 skeleton survives. Residual
 * punctuation routes back through the fold table. Undefined means no
 * printable form remains, so the caller falls back to '?'.
 * @param {string} ch - One Unicode character.
 * @returns {string | undefined} Folded text or undefined.
 */
function foldToAscii(ch) {
    const decomposed = ch.normalize('NFKD').replace(COMBINING_MARKS, '');
    if (decomposed === ch) {
        return undefined;
    }
    let out = '';
    for (const part of decomposed) {
        const codePoint = part.codePointAt(0);
        if (codePoint !== undefined && isAsciiOrLatin1(codePoint)) {
            out += part;
            continue;
        }
        const fold = CHAR_FOLD[part];
        if (fold === undefined) {
            return undefined;
        }
        out += fold;
    }
    return out;
}

/**
 * Fold one non-ASCII character: emoji and punctuation tables, box drawing
 * to ASCII, NFKD decomposition, decorative emoji drop, '?' last resort.
 * @param {string} ch - One Unicode character.
 * @param {number} codePoint - Its code point.
 * @returns {{ glyph: string, fallback: boolean } | null} Glyph or null to drop.
 */
function foldNonAscii(ch, codePoint) {
    const emoji = EMOJI_FOLD[ch];
    if (emoji !== undefined) {
        return { glyph: emoji, fallback: false };
    }
    const fold = CHAR_FOLD[ch];
    if (fold !== undefined) {
        return { glyph: fold, fallback: false };
    }
    if (codePoint >= 0x2500 && codePoint <= 0x257f) {
        if (codePoint === 0x2502 || codePoint === 0x2503) {
            return { glyph: '|', fallback: false };
        }
        if (codePoint === 0x2500 || codePoint === 0x2501) {
            return { glyph: '-', fallback: false };
        }
        return { glyph: '+', fallback: false };
    }
    const folded = foldToAscii(ch);
    if (folded !== undefined) {
        return { glyph: folded, fallback: false };
    }
    if (EMOJI_PICTOGRAPH.test(ch) || UNRENDERABLE.test(ch)) {
        return null;
    }
    return { glyph: '?', fallback: true };
}

/**
 * Strip ANSI sequences, collapse whitespace runs, and fold unsupported
 * symbols to printable ASCII. Box drawing maps to -|+ so tables survive,
 * kept Unicode prints through, decorative emoji drops, and unknown glyphs
 * become '?' with stats for the renderability scan.
 * @param {string} text - Raw snippet text.
 * @param {MicroficheNormalizeOptions} [options] - Font hint, reserved.
 * @returns {{ text: string, totalGraphics: number, fallbackCount: number }} Folded text with fallback stats.
 */
function normalizeWithStats(text, options = {}) {
    void options;
    const stripped = String(text).replace(ANSI_RE, '');
    const collapsed = stripped
        .replace(COLLAPSIBLE, (run) =>
            LINE_BREAK.test(run) ? NEWLINE_GLYPH : /[^\p{Cf}]/u.test(run) ? ' ' : '',
        )
        .replace(EDGE_RUNS, '');
    const out = [];
    let totalGraphics = 0;
    let fallbackCount = 0;
    for (const ch of collapsed) {
        const codePoint = ch.codePointAt(0);
        if (codePoint === undefined) {
            continue;
        }
        if (isAsciiOrLatin1(codePoint)) {
            out.push(ch);
            totalGraphics += 1;
            continue;
        }
        if (ch === DIM_ON || ch === DIM_OFF || ch === NEWLINE_GLYPH) {
            out.push(ch);
            continue;
        }
        if (SCRIPT_PRINTABLE.test(ch) && !isWideCodePoint(codePoint)) {
            out.push(ch);
            totalGraphics += 1;
            continue;
        }
        const folded = foldNonAscii(ch, codePoint);
        if (folded === null) {
            continue;
        }
        out.push(folded.glyph);
        totalGraphics += 1;
        if (folded.fallback) {
            fallbackCount += 1;
        }
    }
    return {
        text: out.join('').replace(/ +/g, ' ').replace(EDGE_RUNS, ''),
        totalGraphics,
        fallbackCount,
    };
}

/**
 * Prepare text for printing: strip ANSI sequences, collapse whitespace,
 * fold unsupported symbols, keep renderable Unicode, drop decorative emoji.
 * @param {unknown} text - Raw snippet text; non-strings become ''.
 * @param {MicroficheNormalizeOptions} [options] - Font hint, reserved.
 * @returns {string} Normalized printable text.
 */
export function normalize(text, options = {}) {
    if (typeof text !== 'string') {
        return '';
    }
    return normalizeWithStats(text, options).text;
}

/**
 * Scan text on the same folding path as normalize; unsafe means more than
 * 5% of graphic characters would hit the '?' fallback.
 * @param {unknown} text - Raw snippet text; non-strings scan as safe.
 * @param {MicroficheNormalizeOptions} [options] - Font hint, reserved.
 * @returns {MicroficheRenderability} Safety verdict and fallback ratio.
 */
export function scanRenderability(text, options = {}) {
    if (typeof text !== 'string') {
        return { isSafe: true, unrenderableRatio: 0 };
    }
    const counted = normalizeWithStats(text, options);
    const unrenderableRatio =
        counted.totalGraphics > 0 ? counted.fallbackCount / counted.totalGraphics : 0;
    return { isSafe: unrenderableRatio <= 0.05, unrenderableRatio };
}

/**
 * Wrap each maximal letter run that is a stopword in DIM_ON/DIM_OFF so it
 * prints dim. Spans already inside dim pass through, which keeps nested
 * archived tool output from terminating the enclosing span early.
 * @param {string} text - Normalized page text.
 * @returns {string} Text with dim spans around stopwords.
 */
export function dimStopwords(text) {
    const parts = String(text).split(DIM_MARKER_SPLIT);
    let dim = false;
    let out = '';
    for (const part of parts) {
        if (part === DIM_ON) {
            dim = true;
            out += part;
        } else if (part === DIM_OFF) {
            dim = false;
            out += part;
        } else if (dim) {
            out += part;
        } else {
            out += part.replace(ALPHA_RUN, (word) =>
                STOPWORDS.has(word.toLowerCase()) ? DIM_ON + word + DIM_OFF : word,
            );
        }
    }
    return out;
}
