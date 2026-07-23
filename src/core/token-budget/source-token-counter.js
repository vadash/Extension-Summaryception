import { countTextTokens } from '../token-count.js';
import { parseSnippet } from '../summarizer-state.js';

/**
 * Resolve the source-side token count for a summarizer call.
 *
 * Moved here from `prompts.js` so the budget-hint builder and the size
 * validator share one definition. Pure function over metadata; the caller
 * resolves the upstream metadata values before calling.
 * @param {{ sourceTokensBefore?: number, regexStats?: { finalTokens?: number }, memoryTokensBefore?: number }} [metadata]
 * @returns {number}
 */
export function getSourceTokenCount(metadata = {}) {
    const candidates = [
        metadata.sourceTokensBefore,
        metadata.regexStats?.finalTokens,
        metadata.memoryTokensBefore,
    ];
    for (const value of candidates) {
        const count = Number(value);
        if (Number.isFinite(count) && count > 0) {
            return count;
        }
    }
    return 0;
}

/**
 * Compute source-side token counts for a Layer 0 call, split into the
 * narrative passage and the serialized prior [STATE] block.
 * @param {object} p
 * @param {number} p.sourceNarrativeTokens - Passage token count (already
 *   counted upstream; reuse `getSourceTokenCount` semantics — prefer
 *   `metadata.sourceTokensBefore`, then `metadata.regexStats.finalTokens`,
 *   then `metadata.memoryTokensBefore`; the caller resolves this before
 *   calling). Do NOT recount the passage here.
 * @param {string} p.sourceStateText - Serialized prior [STATE] block (''
 *   when none yet). May be a raw `key: value` body or include the
 *   `[STATE]` header.
 * @returns {Promise<{ narrativeTokens: number, stateTokens: number, stateKeyCount: number }>}
 */
export async function countLayer0SourceBudget({ sourceNarrativeTokens, sourceStateText }) {
    const narrativeValue = Number(sourceNarrativeTokens);
    const narrativeTokens = Number.isFinite(narrativeValue) ? narrativeValue : 0;

    const stateText = String(sourceStateText || '').trim();
    if (!stateText) {
        return { narrativeTokens, stateTokens: 0, stateKeyCount: 0 };
    }

    const stateTokens = (await countTextTokens(stateText)).count;
    const snippet = parseSnippet(
        stateText.includes('[STATE]') ? stateText : `[STATE]\n${stateText}`,
    );
    const stateKeyCount = Object.keys(snippet.state || {}).length;

    return { narrativeTokens, stateTokens, stateKeyCount };
}
