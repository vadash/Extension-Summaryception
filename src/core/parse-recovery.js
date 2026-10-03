import { jsonrepair } from '../vendor/jsonrepair.js';

/**
 * Parse Recovery
 *
 * The deterministic waterfall that turns a malformed Auditor reply into a
 * parseable Continuity State JSON before classification. Tiers run
 * cheapest-first and no tier before the vendored library rewrites string
 * contents; classification's clamps and section verdicts stay the semantic
 * gate after any syntactic rescue.
 *
 * Structural completion (tier 4) runs before balanced-block extraction
 * (tier 5): completion only succeeds when the appended text parses whole, so
 * it preserves the full draft, while extraction drops everything outside the
 * block. A truncated root object must not lose its sections to a balanced
 * inner one.
 */

const FENCE_OPEN = /^(?:```|~~~)[a-zA-Z0-9]*[ \t]*\r?\n?/;
const FENCE_CLOSE = /\r?\n?[ \t]*(?:```|~~~)[ \t]*$/;

// Smart/typographic quotes fold onto their ASCII counterparts. The rewrite
// only survives when its product parses, so it can never damage a draft that
// a later tier would have rescued intact.
const TYPOGRAPHY_REPLACEMENTS = [
    ['\u201C', '"'],
    ['\u201D', '"'],
    ['\u2018', "'"],
    ['\u2019', "'"],
];

/**
 * @param {string} text
 * @returns {string | null}
 */
function stripFences(text) {
    let inner = text;
    if (FENCE_OPEN.test(inner)) {
        inner = inner.replace(FENCE_OPEN, '');
    }
    if (FENCE_CLOSE.test(inner)) {
        inner = inner.replace(FENCE_CLOSE, '');
    }
    return inner === text ? null : inner.trim();
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function sliceBraces(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        return text.slice(start, end + 1);
    }
    return null;
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function normalizeTypography(text) {
    let changed = false;
    let result = text;
    for (const [from, to] of TYPOGRAPHY_REPLACEMENTS) {
        if (result.includes(from)) {
            result = result.split(from).join(to);
            changed = true;
        }
    }
    return changed ? result : null;
}

/**
 * @returns {Array<(text: string) => string | null>}
 */
function tier2Transforms() {
    return [stripFences, sliceBraces];
}

/**
 * @returns {Array<(text: string) => string | null>}
 */
function tier3Transforms() {
    return [normalizeTypography];
}

/**
 * Quote- and escape-aware: brace characters inside string literals never
 * count toward depth.
 * @param {string} text
 * @param {number} start
 * @returns {number}
 */
function balancedEnd(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') {
                i++;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Survives preamble and trailing prose whose braces would fool a naive
 * first/last slice.
 * @param {string} text
 * @returns {string | null}
 */
function extractBalancedBlock(text) {
    let best = null;
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '{') {
            continue;
        }
        const end = balancedEnd(text, i);
        if (end !== -1) {
            const candidate = text.slice(i, end + 1);
            if (best === null || candidate.length > best.length) {
                best = candidate;
            }
        }
    }
    return best;
}

/**
 * Scans outside string literals so string contents stay untouched.
 * @param {string} text
 * @returns {string | null}
 */
function stripTrailingCommas(text) {
    let out = '';
    let inString = false;
    let changed = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (ch === '\\') {
                i++;
                out += text[i] ?? '';
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === ',') {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) {
                j++;
            }
            if (text[j] === '}' || text[j] === ']') {
                changed = true;
                continue;
            }
        }
        out += ch;
    }
    return changed ? out : null;
}

/**
 * @param {string} text
 * @returns {{ stack: string[], inString: boolean, stringIsKey: boolean }}
 */
function scanOpenState(text) {
    const stack = [];
    let inString = false;
    let expectKey = false;
    let stringIsKey = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === '\\') {
                i++;
            } else if (ch === '"') {
                inString = false;
                expectKey = false;
            }
            continue;
        }
        if (/\s/.test(ch)) {
            continue;
        }
        stringIsKey = false;
        if (ch === '"') {
            inString = true;
            stringIsKey = expectKey;
        } else if (ch === '{') {
            stack.push('{');
            expectKey = true;
        } else if (ch === '[') {
            stack.push('[');
            expectKey = false;
        } else if (ch === ':') {
            expectKey = false;
        } else if (ch === ',') {
            expectKey = stack[stack.length - 1] === '{';
        } else if (ch === '}' || ch === ']') {
            stack.pop();
            expectKey = stack[stack.length - 1] === '{';
        }
    }
    return { stack, inString, stringIsKey };
}

/**
 * A draft cut off in key position (a complete string awaiting its value)
 * also gets a `: null` value so the appended closes actually parse.
 * @param {string} text
 * @returns {string | null}
 */
function completeCloses(text) {
    const { stack, inString, stringIsKey } = scanOpenState(text);
    if (!inString && !stringIsKey && stack.length === 0) {
        return null;
    }
    let repaired = text;
    if (inString) {
        repaired += '"';
    }
    if (stringIsKey) {
        repaired += ': null';
    }
    // A draft cut off right after a value separator leaves a dangling comma
    // before the appended closes.
    const tail = repaired.trimEnd();
    if (tail.endsWith(',')) {
        repaired = tail.slice(0, -1);
    }
    while (stack.length > 0) {
        repaired += stack.pop() === '{' ? '}' : ']';
    }
    return repaired;
}

/**
 * @returns {Array<(text: string) => string | null>}
 */
function tier4Transforms() {
    return [stripTrailingCommas, completeCloses];
}

/**
 * @returns {Array<(text: string) => string | null>}
 */
function tier5Transforms() {
    return [extractBalancedBlock];
}

/**
 * @param {number} tier
 * @param {Array<(text: string) => string | null>} transforms
 * @param {string} text
 * @returns {{ tier: number, value: unknown } | null}
 */
function attemptTransforms(tier, transforms, text) {
    for (const transform of transforms) {
        const product = transform(text);
        if (product === null) {
            continue;
        }
        try {
            return { tier, value: JSON.parse(product) };
        } catch {
            // Not valid JSON, so this tier's shape is wrong; the loop tries the next transform.
        }
    }
    return null;
}

/**
 * Returns null when every tier fails; the caller emits the 'parse' verdict
 * and the Catch-up Window re-covers the Exchanges.
 * @param {string | null | undefined} raw
 * @returns {{ tier: number, value: unknown } | null}
 */
export function recoverContinuityJson(raw) {
    if (typeof raw !== 'string') {
        return null;
    }
    const text = raw.trim();
    if (text === '') {
        return null;
    }

    try {
        return { tier: 1, value: JSON.parse(text) };
    } catch {
        // Not valid JSON as received; the transform tiers re-shape it below.
    }

    const tier2 = attemptTransforms(2, tier2Transforms(), text);
    if (tier2 !== null) {
        return tier2;
    }

    const tier3 = attemptTransforms(3, tier3Transforms(), text);
    if (tier3 !== null) {
        return tier3;
    }

    const tier4 = attemptTransforms(4, tier4Transforms(), text);
    if (tier4 !== null) {
        return tier4;
    }

    const tier5 = attemptTransforms(5, tier5Transforms(), text);
    if (tier5 !== null) {
        return tier5;
    }

    return recoverAggressive(text);
}

/**
 * The aggressive tail of the waterfall: the vendored jsonrepair as the final
 * tier. Its string-content rewrites only ever see text every conservative
 * tier already failed on.
 * @param {string} text
 * @returns {{ tier: number, value: unknown } | null}
 */
function recoverAggressive(text) {
    try {
        const repaired = jsonrepair(text) || '';
        const value = JSON.parse(repaired);
        // The library happily "repairs" bare prose into a JSON string; the
        // Auditor contract is a state object, so a primitive rescue is a
        // total failure.
        if (value === null || typeof value !== 'object') {
            return null;
        }
        return { tier: 6, value };
    } catch {
        return null;
    }
}
