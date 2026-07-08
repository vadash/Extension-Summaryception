import { findLastMessage, getPromptDepthsByChatIndex, iterateChatRange } from './chatutils.js';
import { applyRegexToMessage } from './regex-proxy.js';
import { addBudgetStats, countMessageTokens, createBudgetStats } from './token-count.js';
import { buildLayer0Partitions } from './partition-planner.js';

/**
 * @typedef {object} CacheFriendlyPlan
 * @property {'ready' | 'none'} reason - Whether the plan is ready to flush or idle.
 * @property {number} flushStartIdx - First live chat index considered for cache flush.
 * @property {number} flushEndIdx - Inclusive final chat index selected for flushing.
 * @property {number} tailStartIdx - First chat index preserved in the protected live tail.
 * @property {number} liveTokens - Total tokens in the visible live context.
 * @property {number} cacheBudget - Verbatim cache budget from settings.
 * @property {number} protectedTailTokens - Token target reserved for recent live chat.
 * @property {number} estimatedFlushTokens - Estimated tokens selected for Layer 0 flush.
 * @property {import('./chatutils.js').AssistantTurn[]} assistantTurns - Eligible assistant turns before the protected tail.
 * @property {import('./chatutils.js').AssistantTurn[]} batchTurns - Assistant turns in the next Layer 0 partition.
 * @property {import('./partition-planner.js').SourcePartition[]} partitions - Token-balanced flush partitions.
 * @property {number} overflowCount - Count of eligible assistant turns available to flush.
 * @property {import('./token-count.js').BudgetStats} liveStats - Token stats for the visible live context.
 * @property {import('./token-count.js').BudgetStats} flushStats - Token stats for the selected flush source.
 * @property {boolean} tokenBudgetExceeded - Whether live tokens exceed the cache budget.
 */

/**
 * Build the cache-friendly auto flush plan.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @returns {Promise<CacheFriendlyPlan>}
 */
export async function getCacheFriendlyPlan(chat, store, settings) {
    const flushStartIdx = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;
    const liveData = await collectLiveTokenData(chat, flushStartIdx, settings);
    const protectedTailTokens = getProtectedTailTokens(settings.verbatimTokenBudget);
    const empty = (overrides = {}) =>
        buildPlan({
            flushStartIdx,
            liveData,
            settings,
            protectedTailTokens,
            ...overrides,
        });

    if (!isAssistantTriggered(chat, flushStartIdx)) {
        return empty();
    }
    if (liveData.stats.finalTokens <= settings.verbatimTokenBudget) {
        return empty();
    }

    const tailStartIdx = getProtectedTailStart(chat, flushStartIdx, liveData, protectedTailTokens);
    const assistantTurns = getLiveAssistantTurns(chat, flushStartIdx, tailStartIdx - 1);
    if (assistantTurns.length === 0) {
        return empty({ tailStartIdx });
    }

    const flushEndIdx = assistantTurns[assistantTurns.length - 1].index;
    const flushStats = getRangeStats(liveData, flushStartIdx, flushEndIdx);
    const partitions = await buildLayer0Partitions(chat, flushStartIdx, assistantTurns, settings);
    const batchTurns = partitions[0]?.turns || [];

    return empty({
        reason: 'ready',
        flushEndIdx,
        tailStartIdx,
        assistantTurns,
        batchTurns,
        partitions,
        flushStats,
    });
}

/**
 * Calculate the cache-friendly protected tail size from the verbatim budget.
 * @param {number} verbatimTokenBudget
 * @returns {number}
 */
export function getProtectedTailTokens(verbatimTokenBudget) {
    const budget = Number(verbatimTokenBudget);
    const safeBudget = Number.isFinite(budget) ? budget : 0;
    const rounded = Math.round((safeBudget * 0.2) / 1000) * 1000;
    return Math.min(8000, Math.max(4000, rounded));
}

/**
 * Build a cache plan object with normalized discriminants.
 * @param {object} p
 * @param {number} p.flushStartIdx
 * @param {{ stats: import('./token-count.js').BudgetStats }} p.liveData
 * @param {ExtensionSettings} p.settings
 * @param {number} p.protectedTailTokens
 * @param {'ready' | 'none'} [p.reason]
 * @param {number} [p.flushEndIdx]
 * @param {number} [p.tailStartIdx]
 * @param {import('./chatutils.js').AssistantTurn[]} [p.assistantTurns]
 * @param {import('./chatutils.js').AssistantTurn[]} [p.batchTurns]
 * @param {import('./partition-planner.js').SourcePartition[]} [p.partitions]
 * @param {import('./token-count.js').BudgetStats} [p.flushStats]
 * @returns {CacheFriendlyPlan}
 */
function buildPlan({
    flushStartIdx,
    liveData,
    settings,
    protectedTailTokens,
    reason = 'none',
    flushEndIdx = -1,
    tailStartIdx = -1,
    assistantTurns = [],
    batchTurns = [],
    partitions = [],
    flushStats = createBudgetStats(),
}) {
    const normalizedReason = reason === 'ready' ? 'ready' : 'none';
    return {
        reason: normalizedReason,
        flushStartIdx,
        flushEndIdx,
        tailStartIdx,
        liveTokens: liveData.stats.finalTokens,
        cacheBudget: settings.verbatimTokenBudget,
        protectedTailTokens,
        estimatedFlushTokens: flushStats.finalTokens,
        assistantTurns,
        batchTurns,
        partitions,
        overflowCount: assistantTurns.length,
        liveStats: liveData.stats,
        flushStats,
        tokenBudgetExceeded: liveData.stats.finalTokens > settings.verbatimTokenBudget,
    };
}

async function collectLiveTokenData(chat, startIdx, settings) {
    const stats = createBudgetStats();
    const indexTokens = new Map();
    const promptDepths = getPromptDepthsByChatIndex(chat);

    if (startIdx >= chat.length) {
        return { stats, indexTokens };
    }

    for (const { index, message } of iterateChatRange(chat, startIdx, chat.length - 1)) {
        if (isPromptVisibleLiveMessage(message)) {
            const counted = await countLiveMessage(message, promptDepths.get(index), settings);
            addBudgetStats(stats, counted);
            indexTokens.set(index, counted.finalTokens);
        }
    }

    return { stats, indexTokens };
}

async function countLiveMessage(message, depth, settings) {
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

function isAssistantTriggered(chat, startIdx) {
    const latest = findLastMessage(chat, chat.length - 1, isPromptVisibleLiveMessage, startIdx);
    return latest ? !latest.message.is_user : false;
}

function getProtectedTailStart(chat, startIdx, liveData, protectedTailTokens) {
    let total = 0;
    for (const { index } of iterateChatRange(chat, chat.length - 1, startIdx)) {
        const finalTokens = liveData.indexTokens.get(index);
        if (typeof finalTokens !== 'number') {
            continue;
        }
        total += finalTokens;
        if (total >= protectedTailTokens) {
            return index;
        }
    }
    return startIdx;
}

function getLiveAssistantTurns(chat, startIdx, endIdx) {
    const turns = [];
    if (endIdx < startIdx) {
        return turns;
    }

    for (const { index, message } of iterateChatRange(chat, startIdx, endIdx)) {
        if (isPromptVisibleLiveMessage(message) && !message.is_user) {
            turns.push({ index, mes: message.mes, name: message.name || 'Assistant' });
        }
    }
    return turns;
}

function getRangeStats(liveData, startIdx, endIdx) {
    const stats = createBudgetStats();
    for (let i = startIdx; i <= endIdx; i++) {
        const finalTokens = liveData.indexTokens.get(i);
        if (typeof finalTokens !== 'number') {
            continue;
        }
        stats.finalTokens += finalTokens;
        stats.rawTokens += finalTokens;
    }
    return stats;
}

function getMessageLine(message, text) {
    const speaker = message.is_user ? 'Player' : 'Assistant';
    return `${speaker}: ${text}`;
}

function isPromptVisibleLiveMessage(message) {
    if (!message?.mes || !String(message.mes).trim()) {
        return false;
    }
    if (message.extra?.sc_ghosted) {
        return false;
    }
    return !message.is_system && !message.is_hidden;
}
