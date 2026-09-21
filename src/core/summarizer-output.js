import { NOTIFY_EVENTS } from '../foundation/constants.js';
import { warn } from '../foundation/logger.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { validateLayer0OutputSize, validateLayer0Structure } from './layer0-compression.js';
import {
    extractDeclinedReason,
    findPassageShapeRefusal,
    findRefusalPattern,
} from './refusal-guard.js';
import { silentAdapter } from './notify.js';
import { parseNarrativeEnvelope } from './structural-headers.js';
import { normalizeStructuralHeaderLines } from './structural-headers.js';
import { getSourceTokenCount, SUBSTANTIAL_SOURCE_TOKEN_THRESHOLD } from './token-budget.js';

// ─── Output Cleaning ─────────────────────────────────────────────────

const CHINESE_IDEOGRAPH_REGEX = /\p{Script=Han}/gu;
const VISIBLE_CHARACTER_REGEX = /\S/gu;
const MIN_OUTPUT_TOKENS_FOR_SUBSTANTIAL_SOURCE = 30;
const MIN_OUTPUT_CHARS_FOR_SUBSTANTIAL_SOURCE = 150;

/**
 * Strip reasoning tags, thinking blocks, and other model artifacts
 * from the summarizer output. Uses configurable patterns plus
 * regex for common reasoning block formats.
 * @param {string} raw - The raw summarizer response
 * @returns {string} Cleaned text
 */
function cleanSummarizerOutput(raw) {
    let text = raw;

    const s = getEffectiveSettings();

    for (const pattern of s.stripPatterns || []) {
        while (text.includes(pattern)) {
            text = text.replace(pattern, '');
        }
    }

    const blockPatterns = [
        /<\|channel>thought[\s\S]*?<channel\|>/gi,
        /<thinking>[\s\S]*?<\/thinking>/gi,
        /<output>([\s\S]*?)<\/output>/gi,
        /<reasoning>[\s\S]*?<\/reasoning>/gi,
        /<thought>[\s\S]*?<\/thought>/gi,
        /<reflect>[\s\S]*?<\/reflect>/gi,
        /<inner_monologue>[\s\S]*?<\/inner_monologue>/gi,
    ];

    for (const regex of blockPatterns) {
        // For <output> tags, keep the content inside
        if (regex.source.includes('output')) {
            text = text.replace(regex, '$1');
        } else {
            text = text.replace(regex, '');
        }
    }

    text = normalizeStructuralHeaderLines(text);

    text = text.replace(/\n{3,}/g, '\n').trim();

    return text;
}

/**
 * Strip or reject Han-heavy summarizer output when enabled.
 * @param {string} cleanedResult - Output after standard artifact cleanup
 * @param {import('./call-profile.js').CallProfile} profile - Call profile resolved at dispatch
 * @returns {{ text: string, error: (Error & { retryable?: boolean }) | null, percent: string | null }}
 */
function applyChineseOutputPolicy(cleanedResult, profile) {
    if (!profile?.policy?.stripChineseIdeographs) {
        return { text: cleanedResult, error: null, percent: null };
    }

    const stats = getChineseIdeographStats(cleanedResult);
    if (stats.chineseIdeographs > 0 && stats.ratio > 0.1) {
        const percent = (stats.ratio * 100).toFixed(1);
        const error = /** @type {Error & { retryable?: boolean }} */ (
            new Error(`CN ideograph ratio ${percent}% exceeds 10%`)
        );
        error.retryable = true;
        return { text: '', error, percent };
    }

    return {
        text: cleanWhitespace(stripChineseIdeographs(cleanedResult)),
        error: null,
        percent: null,
    };
}

/**
 * Validate cleaned summarizer output before it can be committed: the Refusal
 * Guard (declined marker, then the layer0-family envelope, lexical, and
 * passage-shape checks) and the minimum-output rule for substantial sources.
 * @param {string} text - Cleaned summarizer output
 * @param {import('./call-profile.js').CallProfile} profile - Call profile resolved at dispatch
 * @returns {{ valid: true, error: null } | { valid: false, error: Error & { retryable?: boolean } }}
 */
export function validateSummarizerOutputIntegrity(text, profile) {
    const output = String(text || '').trim();

    // A confessed Refusal short-circuits every further analysis: the model
    // said it declined, and the reason is the diagnosis.
    const declined = declinedRejection(output);
    if (declined) {
        return rejectIntegrity(declined);
    }

    const policyRejection = compressionPolicyRejection(output, profile);
    if (policyRejection) {
        return rejectIntegrity(policyRejection);
    }

    const sourceTokens = getSourceTokenCount(profile?.provenance);
    const tooShort = tooShortRejection(output, sourceTokens);
    if (tooShort) {
        return rejectIntegrity(tooShort);
    }

    return { valid: true, error: null };
}

/**
 * The Declined Marker verdict: a confessed Refusal carries the model's own
 * reason as the diagnosis.
 * @param {string} output - Cleaned summarizer output
 * @returns {string} Empty string without a marker, the rejection reason otherwise
 */
function declinedRejection(output) {
    const declinedReason = extractDeclinedReason(output);
    if (declinedReason === null) {
        return '';
    }
    return declinedReason
        ? `declined the summarization task: ${declinedReason}`
        : 'declined the summarization task';
}

/**
 * The minimum-output rule for substantial sources.
 * @param {string} output - Cleaned summarizer output
 * @param {number} sourceTokens - Source token count from the call's provenance
 * @returns {string} Empty string when the draft passes, the rejection reason otherwise
 */
function tooShortRejection(output, sourceTokens) {
    if (sourceTokens <= SUBSTANTIAL_SOURCE_TOKEN_THRESHOLD || !isOutputTooShortForSource(output)) {
        return '';
    }
    const stats = getApproximateOutputStats(output);
    return (
        `output too short for ${sourceTokens} source tokens ` +
        `(${stats.tokens} tokens, ${stats.characters} characters)`
    );
}

/**
 * The compression-call policy contract: envelope structure for the layer0
 * family, the lexical refusal net for every compression call, and the
 * passage-shape signal for the layer0 family on a substantial source.
 * @param {string} output - Cleaned summarizer output
 * @param {import('./call-profile.js').CallProfile} profile - Call profile resolved at dispatch
 * @returns {string} Empty string when the draft passes, a rejection reason otherwise
 */
function compressionPolicyRejection(output, profile) {
    if (profile?.policy?.sizeGuard) {
        const structuralError = validateLayer0Structure(output);
        if (structuralError) {
            return structuralError;
        }
    }

    // The lexical net runs for every compression call — Layer 0 family and
    // promotion — scoped to the envelope body when one is present, else the
    // whole output. In-story quoted dialogue lives inside the envelope, so it
    // stays inert either way.
    if (profile?.policy?.compression) {
        const refusalKind = findRefusalPattern(narrativeBodyOf(output));
        if (refusalKind) {
            return `refusal pattern (${refusalKind}) in narrative body`;
        }
    }

    if (profile?.policy?.sizeGuard) {
        return findPassageShapeRejection(output, profile);
    }
    return '';
}

/**
 * The narrative body of a compression call's output: inside the Output
 * Envelope when one is present, else the whole text.
 * @param {string} output - Cleaned summarizer output
 * @returns {string}
 */
function narrativeBodyOf(output) {
    const envelope = parseNarrativeEnvelope(output);
    return envelope ? envelope.body : output;
}

/**
 * The passage-shape signal for a substantial Layer 0 source: a body that
 * names none of the passage's recurring characters while describing the text
 * itself is a meta-describing Refusal.
 * @param {string} output - Cleaned summarizer output
 * @param {import('./call-profile.js').CallProfile} profile - Call profile resolved at dispatch
 * @returns {string} Empty string when the draft passes, a rejection reason otherwise
 */
function findPassageShapeRejection(output, profile) {
    const sourceTokens = getSourceTokenCount(profile?.provenance);
    if (sourceTokens <= SUBSTANTIAL_SOURCE_TOKEN_THRESHOLD) {
        return '';
    }
    const censusNames = String(profile?.provenance?.passageNames || '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
    if (findPassageShapeRefusal(narrativeBodyOf(output), censusNames)) {
        return (
            'passage-shape refusal: body names none of the passage names ' +
            `(${censusNames.join(', ')}) while describing the text itself`
        );
    }
    return '';
}
/**
 * Guard summarizer output before committing; warn once when invalid.
 * @param {string} text - Cleaned summarizer output
 * @param {import('./call-profile.js').CallProfile} profile - Call profile resolved at dispatch
 * @param {string} [warnPrefix] - Optional prefix for the warning message
 * @returns {boolean}
 */
export function isSummarizerOutputSafe(text, profile, warnPrefix = '') {
    const integrityResult = validateSummarizerOutputIntegrity(text, profile);
    if (integrityResult.valid) {
        return true;
    }
    warn(`${warnPrefix}${integrityResult.error.message}`);
    return false;
}

/**
 * @param {string} text - Text to inspect
 * @returns {{ chineseIdeographs: number, visibleCharacters: number, ratio: number }}
 */
function getChineseIdeographStats(text) {
    const source = String(text || '');
    const chineseIdeographs = countMatches(source, CHINESE_IDEOGRAPH_REGEX);
    const visibleCharacters = countMatches(source, VISIBLE_CHARACTER_REGEX);
    return {
        chineseIdeographs,
        visibleCharacters,
        ratio: visibleCharacters > 0 ? chineseIdeographs / visibleCharacters : 0,
    };
}

/**
 * @param {string} text - Text to clean
 * @returns {string}
 */
function stripChineseIdeographs(text) {
    return String(text || '').replace(CHINESE_IDEOGRAPH_REGEX, '');
}

function cleanWhitespace(text) {
    return String(text || '')
        .replace(/\n{3,}/g, '\n')
        .trim();
}

function countMatches(text, regex) {
    return text.match(regex)?.length || 0;
}

function isOutputTooShortForSource(text) {
    const stats = getApproximateOutputStats(text);
    return (
        stats.tokens < MIN_OUTPUT_TOKENS_FOR_SUBSTANTIAL_SOURCE &&
        stats.characters < MIN_OUTPUT_CHARS_FOR_SUBSTANTIAL_SOURCE
    );
}

function getApproximateOutputStats(text) {
    const source = String(text || '').trim();
    return {
        tokens: source ? source.split(/\s+/).filter(Boolean).length : 0,
        characters: source.length,
    };
}

/**
 * @param {string} reason
 * @returns {{ valid: false, error: Error & { retryable?: boolean } }}
 */
function rejectIntegrity(reason) {
    const error = /** @type {Error & { retryable?: boolean }} */ (
        new Error(`Summarizer response failed integrity validation: ${reason}`)
    );
    error.retryable = true;
    return { valid: false, error };
}

// ─── Response Processing ──────────────────────────────────────────────

/**
 * Clean and validate a raw provider response.
 * @param {string} rawResult - Raw provider output
 * @param {import('./call-profile.js').CallProfile} profile - Call profile resolved at dispatch
 * @param {import('./notify.js').NotifyAdapter} [notify] - Notify adapter for the language-mix rejection; defaults to the silent adapter
 * @returns {Promise<{ status: 'success', text: string, error: null, repairFeedback: '' } | { status: 'empty' | 'cn-rejected' | 'integrity-rejected' | 'size-rejected', text: string, error: Error & { retryable?: boolean }, repairFeedback: string }>} Rejected attempts keep the cleaned LLM output in `text` for the attempt log; only `empty` has none.
 */
export async function processSummarizerResponse(rawResult, profile, notify = silentAdapter) {
    const cleanedResult = cleanSummarizerOutput((rawResult || '').trim());
    const chinesePolicyResult = applyChineseOutputPolicy(cleanedResult, profile);

    if (chinesePolicyResult.error) {
        notifyLanguageMixRejection(chinesePolicyResult.percent, notify);
        return {
            status: 'cn-rejected',
            text: cleanedResult,
            error: chinesePolicyResult.error,
            repairFeedback: '',
        };
    }

    if (!chinesePolicyResult.text) {
        return {
            status: 'empty',
            text: '',
            error: new Error('Empty response from summarizer'),
            repairFeedback: '',
        };
    }

    const integrityResult = validateSummarizerOutputIntegrity(chinesePolicyResult.text, profile);
    if (!integrityResult.valid) {
        warn(integrityResult.error.message);
        return {
            status: 'integrity-rejected',
            text: chinesePolicyResult.text,
            error: integrityResult.error,
            repairFeedback: '',
        };
    }

    const sizeResult = await validateLayer0OutputSize(chinesePolicyResult.text, profile);
    if (!sizeResult.valid) {
        warn(sizeResult.error.message);
        return {
            status: 'size-rejected',
            text: chinesePolicyResult.text,
            error: sizeResult.error,
            repairFeedback: sizeResult.repairFeedback,
        };
    }

    return {
        status: 'success',
        text: chinesePolicyResult.text,
        error: null,
        repairFeedback: '',
    };
}

/**
 * Emit the structured language-mix event without coupling the output module to
 * UI side effects.
 * @param {string | null} percent
 * @param {import('./notify.js').NotifyAdapter} notify - Notify adapter threaded from the response processing
 * @returns {void}
 */
function notifyLanguageMixRejection(percent, notify) {
    const displayPercent = percent || '?';
    warn(
        `Summarizer response rejected: CN ideographs were ${displayPercent}% of visible characters.`,
    );
    notify.transient({
        kind: NOTIFY_EVENTS.LANGUAGE_MIX_RETRY,
        percent: displayPercent,
    });
}
