import { getPromptDepthsByChatIndex, iterateChatRange } from './chatutils.js';
import { applyRegexToMessage } from './regex-proxy.js';
import { addBudgetStats, countMessageTokens, createBudgetStats } from './token-count.js';

const MIN_L0_SOURCE_TOKENS = 2000;
const L0_SOURCE_OVERSHOOT_TOLERANCE = 1.15;

/**
 * @typedef {object} SourcePartition
 * @property {import('./chatutils.js').AssistantTurn[]} turns
 * @property {number} sourceStartIdx
 * @property {number} sourceEndIdx
 * @property {import('./token-count.js').BudgetStats} stats
 */

/**
 * Build token-balanced Layer 0 source partitions on assistant-turn boundaries.
 * @param {ChatMessage[]} chat
 * @param {number} sourceStartIdx
 * @param {import('./chatutils.js').AssistantTurn[]} assistantTurns
 * @param {ExtensionSettings} settings
 * @param {{ finalSourceEndIdx?: number }} [opts]
 * @returns {Promise<SourcePartition[]>}
 */
export async function buildLayer0Partitions(
    chat,
    sourceStartIdx,
    assistantTurns,
    settings,
    /** @type {{ finalSourceEndIdx?: number }} */ { finalSourceEndIdx } = {},
) {
    const turns = assistantTurns.filter((turn) => turn.index >= sourceStartIdx);
    if (turns.length === 0) {
        return [];
    }

    const segments = await buildTurnSegments(chat, sourceStartIdx, turns, settings, {
        finalSourceEndIdx,
    });
    const totalTokens = sumSegmentTokens(segments);
    const maxTokens = getMaxL0SourceTokens(settings);
    const targetTokens = getTargetSourceTokens(settings);

    if (totalTokens <= Math.ceil(targetTokens * L0_SOURCE_OVERSHOOT_TOLERANCE)) {
        return [buildPartitionFromSegments(segments)];
    }

    const partitionCount = Math.max(1, Math.ceil(totalTokens / targetTokens));
    const softTarget = Math.min(maxTokens, Math.ceil(totalTokens / partitionCount));
    return buildBalancedPartitions(segments, softTarget, maxTokens);
}

/**
 * Count source tokens for an inclusive chat range using Layer 0 passage rules.
 * @param {ChatMessage[]} chat
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {ExtensionSettings} settings
 * @returns {Promise<import('./token-count.js').BudgetStats>}
 */
export async function countSourceRangeTokens(chat, startIdx, endIdx, settings) {
    const stats = createBudgetStats();
    const promptDepths = getPromptDepthsByChatIndex(chat);

    if (endIdx < startIdx) {
        return stats;
    }

    for (const { index, message } of iterateChatRange(chat, startIdx, endIdx)) {
        if (!isPassageCountableMessage(message)) {
            continue;
        }
        addBudgetStats(stats, await countSourceMessage(message, promptDepths.get(index), settings));
    }

    return stats;
}

async function buildTurnSegments(
    chat,
    sourceStartIdx,
    turns,
    settings,
    /** @type {{ finalSourceEndIdx?: number }} */ { finalSourceEndIdx } = {},
) {
    const segments = [];
    let segmentStart = sourceStartIdx;

    for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];
        const isFinal = i === turns.length - 1;
        const endIdx = isFinal ? getFinalEndIdx(turn.index, finalSourceEndIdx) : turn.index;
        segments.push({
            turn,
            sourceStartIdx: segmentStart,
            sourceEndIdx: endIdx,
            stats: await countSourceRangeTokens(chat, segmentStart, endIdx, settings),
        });
        segmentStart = endIdx + 1;
    }

    return segments;
}

function sumSegmentTokens(segments) {
    return segments.reduce((total, segment) => total + segment.stats.finalTokens, 0);
}

function buildBalancedPartitions(segments, softTarget, maxTokens) {
    const partitions = [];
    let current = [];
    let currentTokens = 0;

    for (const segment of segments) {
        const segmentTokens = segment.stats.finalTokens;
        if (
            shouldCutBeforeSegment({ current, currentTokens, segmentTokens, softTarget, maxTokens })
        ) {
            partitions.push(buildPartitionFromSegments(current));
            current = [];
            currentTokens = 0;
        }

        current.push(segment);
        currentTokens += segmentTokens;
    }

    if (current.length > 0) {
        partitions.push(buildPartitionFromSegments(current));
    }

    return partitions;
}

function shouldCutBeforeSegment({ current, currentTokens, segmentTokens, softTarget, maxTokens }) {
    if (current.length === 0) {
        return false;
    }

    const combinedTokens = currentTokens + segmentTokens;
    if (combinedTokens > Math.ceil(maxTokens * L0_SOURCE_OVERSHOOT_TOLERANCE)) {
        return true;
    }

    const currentDistance = Math.abs(softTarget - currentTokens);
    const combinedDistance = Math.abs(softTarget - combinedTokens);
    return (
        currentTokens >= MIN_L0_SOURCE_TOKENS &&
        combinedTokens >= softTarget &&
        currentDistance <= combinedDistance
    );
}

function buildPartitionFromSegments(segments) {
    const stats = createBudgetStats();
    for (const segment of segments) {
        addBudgetStats(stats, segment.stats);
    }

    return {
        turns: segments.map((segment) => segment.turn),
        sourceStartIdx: segments[0].sourceStartIdx,
        sourceEndIdx: segments[segments.length - 1].sourceEndIdx,
        stats,
    };
}

async function countSourceMessage(message, depth, settings) {
    const rawText = String(message.mes || '').trim();
    const finalText = settings.applyRegexScripts
        ? await applyRegexToMessage(rawText, Boolean(message.is_user), depth)
        : rawText;
    const rawLine = getMessageLine(message, rawText);
    const finalLine = getMessageLine(message, finalText);
    const tokens = await countMessageTokens(message, rawLine, finalLine);

    return {
        rawTokens: tokens.rawTokens,
        finalTokens: tokens.finalTokens,
        rawTokensEstimated: tokens.rawTokensEstimated,
        finalTokensEstimated: tokens.finalTokensEstimated,
        changed: rawLine !== finalLine,
    };
}

function getFinalEndIdx(turnIndex, finalSourceEndIdx) {
    if (
        typeof finalSourceEndIdx === 'number' &&
        Number.isInteger(finalSourceEndIdx) &&
        finalSourceEndIdx >= turnIndex
    ) {
        return finalSourceEndIdx;
    }
    return turnIndex;
}

function getMaxL0SourceTokens(settings) {
    const configured = Number(settings.maxL0SourceTokens);
    if (!Number.isFinite(configured) || configured <= 0) {
        return 8000;
    }
    return Math.max(MIN_L0_SOURCE_TOKENS, Math.round(configured));
}

function getTargetSourceTokens(settings) {
    const cap = getMaxL0SourceTokens(settings);
    const budget = Number(settings.minSummaryBudget);
    const safeBudget = Number.isFinite(budget) ? budget : cap;
    return Math.min(cap, Math.max(MIN_L0_SOURCE_TOKENS, Math.round(safeBudget)));
}

function getMessageLine(message, text) {
    const speaker = message.is_user ? 'Player' : 'Assistant';
    return `${speaker}: ${text}`;
}

function isPassageCountableMessage(message) {
    if (!message?.mes || !String(message.mes).trim()) {
        return false;
    }
    return !(message.is_system || message.is_hidden) || message.extra?.sc_ghosted;
}
