import { getCurrentSummarizedBoundary } from './snippet-provenance.js';
import { reconcilePreservedMessages } from './preserved-messages.js';
import { findLastMessage, getAssistantTurns, isSummarizerPassageMessage } from './chatutils.js';
import { buildLayer0Partitions } from './partition-planner.js';

/**
 * @typedef {object} SlopBreakerPlan
 * @property {'ready' | 'none'} reason - Whether there is a cut ready to process
 * @property {number} targetIndex - Fixed chat index the run should summarize through
 * @property {import('./chatutils.js').AssistantTurn[]} eligibleTurns - Assistant turns in target range
 * @property {import('./chatutils.js').AssistantTurn[]} batchTurns - Next capped assistant batch
 * @property {import('./partition-planner.js').SourcePartition[]} partitions - Token-balanced source partitions for the fixed cut
 * @property {number} sourceStartIdx - First chat index in the next contiguous source segment.
 * @property {number} sourceEndIdx - End of the source passage for the next batch
 * @property {number} totalBatches - Estimated batches needed for the full cut
 */

/**
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @param {{ targetIndex?: number }} [opts]
 * @returns {Promise<SlopBreakerPlan>}
 */
export async function getSlopBreakerPlan(chat, store, settings, { targetIndex } = {}) {
    reconcilePreservedMessages(chat, store);
    const summarizedBoundary = getCurrentSummarizedBoundary(chat, store);
    const resolvedTargetIndex = resolveSlopTargetIndex(
        chat,
        store,
        summarizedBoundary,
        targetIndex,
    );

    if (typeof resolvedTargetIndex !== 'number' || resolvedTargetIndex <= summarizedBoundary) {
        return buildEmptyPlan(resolvedTargetIndex ?? -1);
    }

    const eligibleTurns = getEligibleAssistantTurns(
        chat,
        store,
        summarizedBoundary,
        resolvedTargetIndex,
    );
    if (eligibleTurns.length === 0) {
        return buildEmptyPlan(resolvedTargetIndex);
    }

    const partitions = await buildLayer0Partitions({
        chat,
        store,
        sourceStartIdx: summarizedBoundary < 0 ? 0 : summarizedBoundary + 1,
        assistantTurns: eligibleTurns,
        settings,
        finalSourceEndIdx: resolvedTargetIndex,
    });
    const firstPartition = partitions[0];

    return {
        reason: 'ready',
        targetIndex: resolvedTargetIndex,
        sourceStartIdx: firstPartition?.sourceStartIdx ?? summarizedBoundary + 1,
        eligibleTurns,
        batchTurns: firstPartition?.turns || [],
        partitions,
        sourceEndIdx: firstPartition?.sourceEndIdx ?? resolvedTargetIndex,
        totalBatches: Math.max(1, partitions.length),
    };
}

/**
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {number} boundaryIndex
 * @param {number | undefined} targetIndex
 * @returns {number | null}
 */
function resolveSlopTargetIndex(chat, store, boundaryIndex, targetIndex) {
    const defaultTarget = getSlopBreakerTargetIndex(chat, boundaryIndex, store);
    if (typeof targetIndex === 'number' && Number.isInteger(targetIndex) && targetIndex >= 0) {
        return targetIndex;
    }
    return defaultTarget;
}

/**
 * @param {number} boundaryIndex
 * @returns {number | null}
 */
function getSlopBreakerTargetIndex(chat, boundaryIndex, store) {
    const latest = findLastMessage(chat, chat.length - 1, (message) =>
        isSummarizerPassageMessage(message, store),
    );
    if (!latest || latest.index <= boundaryIndex) {
        return null;
    }
    // A batch counts assistant turns only, so the cut cannot end on a user
    // message; fall back to the latest eligible message before it.
    if (!latest.message.is_user) {
        return latest.index;
    }
    return (
        findLastMessage(chat, latest.index - 1, (message) =>
            isSummarizerPassageMessage(message, store),
        )?.index ?? null
    );
}

/**
 * @param {number} boundaryIndex
 * @param {number} targetIndex
 * @returns {import('./chatutils.js').AssistantTurn[]}
 */
function getEligibleAssistantTurns(chat, store, boundaryIndex, targetIndex) {
    return getAssistantTurns(chat, store).filter(
        (turn) =>
            turn.index > boundaryIndex &&
            turn.index <= targetIndex &&
            isSummarizerPassageMessage(chat[turn.index], store),
    );
}

/**
 * @param {number} targetIndex
 * @returns {SlopBreakerPlan}
 */
function buildEmptyPlan(targetIndex) {
    return {
        reason: 'none',
        targetIndex,
        sourceStartIdx: targetIndex,
        eligibleTurns: [],
        batchTurns: [],
        partitions: [],
        sourceEndIdx: targetIndex,
        totalBatches: 0,
    };
}
