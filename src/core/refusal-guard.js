// Refusal Guard (ADR-0015): deterministic classification of Refusals in
// summarizer output. Three signals, no judge call, no settings: the Declined
// Marker the prompts sanction, the frozen lexical refusal set, and the
// passage-shape signal over the passage's character-name census. A classified
// Refusal is always a retryable rejection, never stored prose.

// The Declined Marker is a single-line construct: <declined>reason</declined>.
// The reason is free text the model chose; an empty reason is legal. The
// marker must close the output, so a marker merely mentioned mid-prose stays
// inert.
const DECLINED_OUTPUT_RE = /(?:^|\r?\n)\s*<declined>([\s\S]*?)<\/declined>\s*$/i;

// Lexical refusal patterns (v1, frozen). First-person inability or deflection,
// policy vocabulary, and the assistant-identity tell. Scope: the narrative
// body only, so quoted in-story dialogue and summarized character speech
// cannot trip them.
const REFUSAL_PATTERNS = [
    {
        kind: 'inability',
        re: /\bI\s+(?:can'?t|cannot|can\s+not|won'?t|am\s+unable|am\s+not\s+able)\b[^.?!]{0,80}\b(?:summariz\w*|rewrite|process|compress|assist|help)\b/i,
    },
    {
        kind: 'deflection',
        re: /\bI\s+can\s+(?:offer|suggest|help)\b[^.?!]{0,80}\binstead\b/i,
    },
    { kind: 'policy', re: /\bcontent\s+policy\b/i },
    { kind: 'policy', re: /\bexplicit\s+sexual\b/i },
    { kind: 'policy', re: /\bsexual\s+content\b/i },
    { kind: 'identity', re: /\bAs\s+an\s+AI\b/i },
];

// Passage-shape signal: a refusal talks about the text, a summary talks about
// the events. A substantial-source body naming none of the census names is a
// Refusal only when it also references the text itself.
const SHAPE_META_REFERENCES = [
    /\bpassage\b/i,
    /\btext\b/i,
    /\bcontent\b/i,
    /\bmaterial\b/i,
    /\brequest\b/i,
    /\bprompt\b/i,
    /\bsummar\w*/i,
    /\bnarrative\b/i,
    /\boutput\b/i,
];

const PASSAGE_NAME_CENSUS_LIMIT = 8;
const PASSAGE_NAME_MIN_OCCURRENCES = 2;
const CENSUS_TOKEN_RE = /\b[A-Z][a-zA-Z]{1,15}\b/g;
// Recurring non-name tokens that would otherwise flood the census: function
// words, pronouns, discourse filler, weekdays, months. Character names are
// decided by frequency, never by a family-title blacklist.
const CENSUS_STOP_TOKENS = new Set([
    'the',
    'a',
    'an',
    'and',
    'but',
    'or',
    'so',
    'if',
    'when',
    'while',
    'as',
    'at',
    'on',
    'in',
    'to',
    'of',
    'for',
    'with',
    'by',
    'from',
    'up',
    'out',
    'off',
    'over',
    'under',
    'again',
    'he',
    'she',
    'it',
    'they',
    'we',
    'you',
    'i',
    'his',
    'her',
    'hers',
    'him',
    'their',
    'theirs',
    'its',
    'my',
    'our',
    'your',
    'me',
    'us',
    'them',
    'this',
    'that',
    'these',
    'those',
    'there',
    'then',
    'than',
    'thus',
    'what',
    'who',
    'whom',
    'whose',
    'which',
    'where',
    'why',
    'how',
    'not',
    'no',
    'yes',
    'ok',
    'okay',
    'well',
    'now',
    'soon',
    'today',
    'tomorrow',
    'yesterday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
    'chapter',
    'part',
    'scene',
]);

/**
 * Read the Declined Marker reason out of cleaned summarizer output.
 * @param {string} text - Cleaned summarizer output
 * @returns {string | null} The reason (possibly empty), or null without a marker
 */
export function extractDeclinedReason(text) {
    const match = DECLINED_OUTPUT_RE.exec(String(text || '').trim());
    return match ? match[1].trim() : null;
}

/**
 * Match the frozen lexical refusal set against a narrative body.
 * @param {string} text - Narrative body text to inspect
 * @returns {string | null} The pattern kind, or null when nothing matches
 */
export function findRefusalPattern(text) {
    const source = String(text || '');
    for (const { kind, re } of REFUSAL_PATTERNS) {
        if (re.test(source)) {
            return kind;
        }
    }
    return null;
}

/**
 * Build the passage's character-name census: capitalized tokens recurring at
 * least twice, ranked by frequency then first occurrence, capped. Pure text
 * statistics; no host access, no player-name resolution.
 * @param {string} passageText - The raw Passage text one request summarizes
 * @returns {string[]} Up to eight passage names, empty for nameless input
 */
export function buildPassageNameCensus(passageText) {
    const source = String(passageText || '');
    if (!source) {
        return [];
    }
    /** @type {Map<string, { count: number, first: number }>} */
    const stats = new Map();
    for (const match of source.matchAll(CENSUS_TOKEN_RE)) {
        const token = match[0];
        if (CENSUS_STOP_TOKENS.has(token.toLowerCase())) {
            continue;
        }
        const entry = stats.get(token) || { count: 0, first: match.index };
        entry.count += 1;
        stats.set(token, entry);
    }
    return [...stats.entries()]
        .filter(([, entry]) => entry.count >= PASSAGE_NAME_MIN_OCCURRENCES)
        .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
        .slice(0, PASSAGE_NAME_CENSUS_LIMIT)
        .map(([token]) => token);
}

/**
 * The passage-shape signal: does the body reference the text itself while
 * naming none of the passage's recurring characters? A census empty by
 * construction never flags, so nameless narration cannot false-trip.
 * @param {string} narrativeBody - The draft's narrative body
 * @param {string[]} censusNames - The passage name census
 * @returns {boolean} True when the shape matches a meta-describing Refusal
 */
export function findPassageShapeRefusal(narrativeBody, censusNames) {
    const body = String(narrativeBody || '');
    const names = Array.isArray(censusNames) ? censusNames : [];
    if (names.length === 0) {
        return false;
    }
    const lowerBody = body.toLowerCase();
    const namesOne = names.some((name) => lowerBody.includes(name.toLowerCase()));
    if (namesOne) {
        return false;
    }
    return SHAPE_META_REFERENCES.some((re) => re.test(body));
}
