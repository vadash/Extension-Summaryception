import { getPromptDepthsByChatIndex } from './chatutils.js';
import { applyRegexToMessage } from './regex-proxy.js';
import { countMessageTokens } from './token-count.js';

/**
 * @typedef {object} CacheFlushChunk
 * @property {number} startIdx
 * @property {number} endIdx
 * @property {number} assistantTurnCount
 * @property {number} finalTokens
 */

/**
 * @typedef {object} CacheFriendlyPlan
 * @property {'ready' | 'none'} reason
 * @property {number} flushStartIdx
 * @property {number} flushEndIdx
 * @property {number} tailStartIdx
 * @property {number} liveTokens
 * @property {number} cacheBudget
 * @property {number} protectedTailTokens
 * @property {number} estimatedFlushTokens
 * @property {import('./chatutils.js').AssistantTurn[]} assistantTurns
 * @property {CacheFlushChunk[]} chunks
 * @property {import('./verbatim-window.js').VerbatimBudgetStats} liveStats
 * @property {import('./verbatim-window.js').VerbatimBudgetStats} flushStats
 * @property {boolean} tokenBudgetExceeded
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
    const chunks = buildCacheChunks({
        flushStartIdx,
        assistantTurns,
        chunkCount: getChunkCount(assistantTurns.length, flushStats.finalTokens, settings),
        liveData,
    });

    return empty({
        reason: 'ready',
        flushEndIdx,
        tailStartIdx,
        assistantTurns,
        flushStats,
        chunks,
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
 * @param {{ stats: import('./verbatim-window.js').VerbatimBudgetStats }} p.liveData
 * @param {ExtensionSettings} p.settings
 * @param {number} p.protectedTailTokens
 * @param {'ready' | 'none'} [p.reason]
 * @param {number} [p.flushEndIdx]
 * @param {number} [p.tailStartIdx]
 * @param {import('./chatutils.js').AssistantTurn[]} [p.assistantTurns]
 * @param {import('./verbatim-window.js').VerbatimBudgetStats} [p.flushStats]
 * @param {CacheFlushChunk[]} [p.chunks]
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
    flushStats = createBudgetStats(),
    chunks = [],
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
        chunks,
        liveStats: liveData.stats,
        flushStats,
        tokenBudgetExceeded: liveData.stats.finalTokens > settings.verbatimTokenBudget,
    };
}

async function collectLiveTokenData(chat, startIdx, settings) {
    const stats = createBudgetStats();
    const indexTokens = new Map();
    const cumulativeByIndex = new Map();
    const promptDepths = getPromptDepthsByChatIndex(chat);
    let cumulative = 0;

    for (let i = startIdx; i < chat.length; i++) {
        const message = chat[i];
        if (isPromptVisibleLiveMessage(message)) {
            const counted = await countLiveMessage(message, promptDepths.get(i), settings);
            addBudgetStats(stats, counted);
            indexTokens.set(i, counted.finalTokens);
            cumulative += counted.finalTokens;
        }
        cumulativeByIndex.set(i, cumulative);
    }

    return { stats, indexTokens, cumulativeByIndex };
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
    for (let i = chat.length - 1; i >= startIdx; i--) {
        const message = chat[i];
        if (!isPromptVisibleLiveMessage(message)) {
            continue;
        }
        return !message.is_user;
    }
    return false;
}

function getProtectedTailStart(chat, startIdx, liveData, protectedTailTokens) {
    let total = 0;
    for (let i = chat.length - 1; i >= startIdx; i--) {
        const finalTokens = liveData.indexTokens.get(i);
        if (typeof finalTokens !== 'number') {
            continue;
        }
        total += finalTokens;
        if (total >= protectedTailTokens) {
            return i;
        }
    }
    return startIdx;
}

function getLiveAssistantTurns(chat, startIdx, endIdx) {
    const turns = [];
    for (let i = Math.max(0, startIdx); i <= endIdx; i++) {
        const message = chat[i];
        if (isPromptVisibleLiveMessage(message) && !message.is_user) {
            turns.push({ index: i, mes: message.mes, name: message.name || 'Assistant' });
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

function getChunkCount(assistantTurnCount, flushTokens, settings) {
    const target = Math.max(1, settings.minSummaryBudget);
    return Math.min(assistantTurnCount, Math.max(1, Math.ceil(flushTokens / target)));
}

function buildCacheChunks({ flushStartIdx, assistantTurns, chunkCount, liveData }) {
    if (assistantTurns.length === 0) {
        return [];
    }

    const endpoints = assistantTurns.map((turn) => turn.index);
    const totalTokens = getCumulative(liveData, endpoints[endpoints.length - 1]);
    const chunks = [];
    let previousPosition = -1;
    let previousEndIdx = flushStartIdx - 1;

    for (let boundary = 1; boundary < chunkCount; boundary++) {
        const endpointPosition = chooseChunkEndpoint({
            boundary,
            chunkCount,
            endpoints,
            previousPosition,
            totalTokens,
            liveData,
        });
        chunks.push(
            buildChunk(previousEndIdx + 1, endpointPosition, previousPosition, endpoints, liveData),
        );
        previousPosition = endpointPosition;
        previousEndIdx = endpoints[endpointPosition];
    }

    chunks.push(
        buildChunk(previousEndIdx + 1, endpoints.length - 1, previousPosition, endpoints, liveData),
    );
    return chunks;
}

function chooseChunkEndpoint({
    boundary,
    chunkCount,
    endpoints,
    previousPosition,
    totalTokens,
    liveData,
}) {
    const minPosition = previousPosition + 1;
    const maxPosition = endpoints.length - (chunkCount - boundary) - 1;
    const target = (totalTokens * boundary) / chunkCount;
    let bestPosition = minPosition;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (let pos = minPosition; pos <= maxPosition; pos++) {
        const distance = Math.abs(getCumulative(liveData, endpoints[pos]) - target);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestPosition = pos;
        }
    }
    return bestPosition;
}

function buildChunk(startIdx, endpointPosition, previousPosition, endpoints, liveData) {
    const endIdx = endpoints[endpointPosition];
    const beforeStart = startIdx <= 0 ? 0 : getCumulative(liveData, startIdx - 1);
    return {
        startIdx,
        endIdx,
        assistantTurnCount: endpointPosition - previousPosition,
        finalTokens: getCumulative(liveData, endIdx) - beforeStart,
    };
}

function getCumulative(liveData, index) {
    return liveData.cumulativeByIndex.get(index) || 0;
}

function createBudgetStats() {
    return {
        rawTokens: 0,
        finalTokens: 0,
        savedTokens: 0,
        rawTokensEstimated: false,
        finalTokensEstimated: false,
        savedTokensEstimated: false,
        changedMessageCount: 0,
    };
}

function addBudgetStats(stats, counted) {
    stats.rawTokens += counted.rawTokens;
    stats.finalTokens += counted.finalTokens;
    stats.savedTokens = stats.rawTokens - stats.finalTokens;
    stats.rawTokensEstimated ||= counted.rawTokensEstimated;
    stats.finalTokensEstimated ||= counted.finalTokensEstimated;
    stats.savedTokensEstimated = stats.rawTokensEstimated || stats.finalTokensEstimated;
    if (counted.changed) {
        stats.changedMessageCount++;
    }
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
