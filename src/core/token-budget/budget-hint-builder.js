import { applySafetyGap } from './safety-gap.js';
import {
    computeNarrativeSentenceCap,
    computeStateLineCap,
    STATE_KEY_CEILING,
} from './structural-constraints.js';

/**
 * Build the `<summaryception_source_budget>` prompt block injected into the
 * Layer 0 prompt. Carries source-relative token budgets (with a 10% safety
 * gap applied to the real validation bounds) and model-countable structural
 * caps so the model can aim below the real ceilings on the first attempt.
 * @param {object} p
 * @param {number} p.sourceNarrativeTokens - Source passage token count.
 * @param {number} p.sourceStateTokens - Serialized prior [STATE] token count.
 * @param {number} p.sourceStateKeyCount - Keys present in the prior snapshot.
 * @param {{ target: number, max: number }} p.narrativeBounds - Real bounds from `getLayer0SummaryTokenBounds`.
 * @param {{ softTarget: number, max: number }} p.stateBounds - Real STATE_SNAPSHOT_SOFT_TARGET/MAX.
 * @returns {string} Prompt block text (no trailing newline).
 */
export function buildLayer0BudgetHint({
    sourceNarrativeTokens,
    sourceStateTokens,
    sourceStateKeyCount,
    narrativeBounds,
    stateBounds,
}) {
    const narrativeTarget = applySafetyGap(narrativeBounds.target);
    const narrativeMax = applySafetyGap(narrativeBounds.max);
    const sentenceCap = computeNarrativeSentenceCap(sourceNarrativeTokens);
    const stateTarget = applySafetyGap(stateBounds.softTarget);
    const stateMax = applySafetyGap(stateBounds.max);

    const hasState = Number(sourceStateTokens) > 0;
    const stateLineCap = hasState ? computeStateLineCap(sourceStateKeyCount) : STATE_KEY_CEILING;

    const existingStateLine = hasState
        ? `Existing [STATE]: ~${sourceStateTokens} tokens, ${sourceStateKeyCount} keys.`
        : 'No existing [STATE] yet — build the first snapshot.';

    return [
        '<summaryception_source_budget>',
        `Source passage: ~${sourceNarrativeTokens} tokens. Compress hard.`,
        `[NARRATIVE]: aim ~${narrativeTarget} tokens; never exceed ${narrativeMax}. At most ${sentenceCap} sentences.`,
        existingStateLine,
        `[STATE]: rewrite the full snapshot; aim ~${stateTarget} tokens; never exceed ${stateMax}. At most ${stateLineCap} lines.`,
        '</summaryception_source_budget>',
    ].join('\n');
}
