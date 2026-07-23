export const STATE_KEY_CEILING = 7;
export const NARRATIVE_SENTENCE_FLOOR = 3;
export const NARRATIVE_SENTENCE_CEILING = 5;
export const NARRATIVE_TOKENS_PER_SENTENCE = 500;

/**
 * Maximum number of `[STATE]` key:value lines the model should emit.
 * @param {number | undefined} sourceStateKeyCount - Keys present in the prior snapshot.
 * @returns {number}
 */
export function computeStateLineCap(sourceStateKeyCount) {
    const count = Number(sourceStateKeyCount);
    if (!Number.isFinite(count) || count <= 0) {
        return STATE_KEY_CEILING;
    }
    return Math.min(count, STATE_KEY_CEILING);
}

/**
 * Maximum number of NARRATIVE sentences the model should emit, derived from
 * the source passage token count.
 * @param {number | undefined} sourceNarrativeTokens - Source passage token count.
 * @returns {number}
 */
export function computeNarrativeSentenceCap(sourceNarrativeTokens) {
    const tokens = Number(sourceNarrativeTokens);
    if (!Number.isFinite(tokens) || tokens <= 0) {
        return NARRATIVE_SENTENCE_FLOOR;
    }
    const raw = Math.ceil(tokens / NARRATIVE_TOKENS_PER_SENTENCE);
    return Math.min(NARRATIVE_SENTENCE_CEILING, Math.max(NARRATIVE_SENTENCE_FLOOR, raw));
}
