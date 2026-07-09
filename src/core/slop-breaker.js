import { findLastMessage, getAssistantTurns } from './chatutils.js';
import { buildLayer0Partitions } from './partition-planner.js';

/**
 * @typedef {object} SlopBreakerPlan
 * @property {'ready' | 'none'} reason - Whether there is a cut ready to process
 * @property {number} targetIndex - Fixed chat index the run should summarize through
 * @property {import('./chatutils.js').AssistantTurn[]} eligibleTurns - Assistant turns in target range
 * @property {import('./chatutils.js').AssistantTurn[]} batchTurns - Next capped assistant batch
 * @property {import('./partition-planner.js').SourcePartition[]} partitions - Token-balanced source partitions for the fixed cut
 * @property {number} sourceEndIdx - End of the source passage for the next batch
 * @property {number} totalBatches - Estimated batches needed for the full cut
 */

/**
 * Build the Slop Breaker plan for the current chat tail.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @param {{ targetIndex?: number }} [opts]
 * @returns {Promise<SlopBreakerPlan>}
 */
export async function getSlopBreakerPlan(chat, store, settings, { targetIndex } = {}) {
    let resolvedTargetIndex = getSlopBreakerTargetIndex(chat, store.summarizedUpTo);
    if (typeof targetIndex === 'number' && Number.isInteger(targetIndex) && targetIndex >= 0) {
        resolvedTargetIndex = targetIndex;
    }

    if (typeof resolvedTargetIndex !== 'number' || resolvedTargetIndex <= store.summarizedUpTo) {
        return buildEmptyPlan(resolvedTargetIndex ?? -1);
    }

    const eligibleTurns = getEligibleAssistantTurns(
        chat,
        store.summarizedUpTo,
        resolvedTargetIndex,
    );
    if (eligibleTurns.length === 0) {
        return buildEmptyPlan(resolvedTargetIndex);
    }

    const partitions = await buildLayer0Partitions({
        chat,
        sourceStartIdx: store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1,
        assistantTurns: eligibleTurns,
        settings,
        finalSourceEndIdx: resolvedTargetIndex,
    });
    const firstPartition = partitions[0];

    return {
        reason: 'ready',
        targetIndex: resolvedTargetIndex,
        eligibleTurns,
        batchTurns: firstPartition?.turns || [],
        partitions,
        sourceEndIdx: firstPartition?.sourceEndIdx ?? resolvedTargetIndex,
        totalBatches: Math.max(1, partitions.length),
    };
}

/**
 * Determine the fixed endpoint for a Slop Breaker cut.
 * @param {ChatMessage[]} chat
 * @param {number} summarizedUpTo
 * @returns {number | null}
 */
function getSlopBreakerTargetIndex(chat, summarizedUpTo) {
    const latest = findLastMessage(chat, chat.length - 1, isCountableConversationMessage);
    if (!latest || latest.index <= summarizedUpTo) {
        return null;
    }
    if (!latest.message.is_user) {
        return latest.index;
    }

    const previous = findLastMessage(chat, latest.index - 1, isCountableConversationMessage);
    return previous?.index ?? null;
}

/**
 * Get assistant turns inside the fixed Slop Breaker target range.
 * @param {ChatMessage[]} chat
 * @param {number} summarizedUpTo
 * @param {number} targetIndex
 * @returns {import('./chatutils.js').AssistantTurn[]}
 */
function getEligibleAssistantTurns(chat, summarizedUpTo, targetIndex) {
    return getAssistantTurns(chat).filter(
        (turn) =>
            turn.index > summarizedUpTo &&
            turn.index <= targetIndex &&
            isCountableConversationMessage(chat[turn.index]),
    );
}

/**
 * Check whether a message belongs to summarizable conversation text.
 * @param {ChatMessage | undefined} message
 * @returns {message is ChatMessage}
 */
function isCountableConversationMessage(message) {
    if (!message?.mes || !String(message.mes).trim()) {
        return false;
    }
    return !(message.is_system || message.is_hidden) || message.extra?.sc_ghosted === true;
}

/**
 * Build an empty Slop Breaker plan.
 * @param {number} targetIndex
 * @returns {SlopBreakerPlan}
 */
function buildEmptyPlan(targetIndex) {
    return {
        reason: 'none',
        targetIndex,
        eligibleTurns: [],
        batchTurns: [],
        partitions: [],
        sourceEndIdx: targetIndex,
        totalBatches: 0,
    };
}
