import { getAssistantTurns, getPromptDepthsByChatIndex } from './chatutils.js';
import { applyRegexToMessage } from './regex-proxy.js';
import { countMessageTokens } from './token-count.js';

/**
 * @typedef {object} VerbatimBudgetStats
 * @property {number} rawTokens
 * @property {number} finalTokens
 * @property {number} savedTokens
 * @property {boolean} rawTokensEstimated
 * @property {boolean} finalTokensEstimated
 * @property {boolean} savedTokensEstimated
 * @property {number} changedMessageCount
 */

/**
 * @typedef {object} Layer0OverflowPlan
 * @property {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @property {import('./chatutils.js').AssistantTurn[]} eligibleTurns
 * @property {import('./chatutils.js').AssistantTurn[]} batchTurns
 * @property {'budget' | 'max' | 'repair' | 'none'} reason
 * @property {number} overflowCount - Total eligible assistant turns outside the verbatim window.
 * @property {number} softOverflowCount - Overflow turns not selected in the current batch.
 * @property {number} visibleTurnCount
 * @property {number} tokenBoundaryIndex
 * @property {VerbatimBudgetStats} budgetStats
 * @property {VerbatimBudgetStats} summaryStats
 * @property {boolean} tokenBudgetExceeded
 */

/**
 * @typedef {object} VerbatimWindowSettings
 * @property {number} minSummaryTurns
 * @property {number} maxSummaryTurns
 * @property {number} minSummaryBudget
 * @property {number} verbatimTokenBudget
 * @property {boolean} applyRegexScripts
 */

/**
 * Build the current Layer 0 overflow plan from chat state and settings.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {VerbatimWindowSettings} settings
 * @returns {Promise<Layer0OverflowPlan>}
 */
export async function getLayer0OverflowPlan(chat, store, settings) {
    const visibleTurns = getVisibleAssistantTurns(chat);
    const eligibleTurns = visibleTurns.filter((turn) => turn.index > store.summarizedUpTo);
    const budget = await getTokenBudgetBoundary(chat, settings);
    const overflowTurns = eligibleTurns.filter((turn) => turn.index <= budget.boundaryIndex);
    const batchLimit = Math.max(1, settings.maxSummaryTurns);
    const candidateTurns = overflowTurns.slice(0, batchLimit);
    const summaryStats = await getSummaryStats(chat, store, candidateTurns, settings);

    if (candidateTurns.length >= settings.maxSummaryTurns) {
        return buildPlan(
            'max',
            visibleTurns,
            eligibleTurns,
            overflowTurns,
            candidateTurns,
            budget,
            summaryStats,
        );
    }

    if (
        candidateTurns.length >= settings.minSummaryTurns &&
        summaryStats.finalTokens >= settings.minSummaryBudget
    ) {
        return buildPlan(
            'budget',
            visibleTurns,
            eligibleTurns,
            overflowTurns,
            candidateTurns,
            budget,
            summaryStats,
        );
    }

    if (budget.exceeded && eligibleTurns.length === 0) {
        return buildPlan(
            'repair',
            visibleTurns,
            eligibleTurns,
            overflowTurns,
            [],
            budget,
            summaryStats,
        );
    }

    return buildPlan('none', visibleTurns, eligibleTurns, overflowTurns, [], budget, summaryStats);
}

function getVisibleAssistantTurns(chat) {
    return getAssistantTurns(chat).filter((turn) => !chat[turn.index]?.extra?.sc_ghosted);
}

function buildPlan(
    reason,
    visibleTurns,
    eligibleTurns,
    overflowTurns,
    batchTurns,
    budget,
    summaryStats,
) {
    return {
        visibleTurns,
        eligibleTurns,
        batchTurns,
        reason,
        overflowCount: overflowTurns.length,
        softOverflowCount: Math.max(0, overflowTurns.length - batchTurns.length),
        visibleTurnCount: visibleTurns.length,
        tokenBoundaryIndex: budget.boundaryIndex,
        budgetStats: budget.stats,
        summaryStats,
        tokenBudgetExceeded: budget.exceeded,
    };
}

async function getTokenBudgetBoundary(chat, settings) {
    const stats = createBudgetStats();
    let totalTokens = 0;
    let boundaryIndex = -1;
    let exceeded = false;

    const promptDepths = getPromptDepthsByChatIndex(chat);
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!isPromptVisibleMessage(message)) {
            continue;
        }

        const counted = await countBudgetMessage(message, promptDepths.get(i), settings);
        addBudgetStats(stats, counted);
        totalTokens += counted.finalTokens;
        if (!exceeded && totalTokens > settings.verbatimTokenBudget) {
            exceeded = true;
            boundaryIndex = i;
        }
    }

    return { boundaryIndex, exceeded, stats };
}

async function getSummaryStats(chat, store, candidateTurns, settings) {
    if (candidateTurns.length === 0) {
        return createBudgetStats();
    }

    const startIdx = store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;
    const endIdx = candidateTurns[candidateTurns.length - 1].index;
    return await countRangeTokens(chat, startIdx, endIdx, settings);
}

async function countRangeTokens(chat, startIdx, endIdx, settings) {
    const stats = createBudgetStats();
    const promptDepths = getPromptDepthsByChatIndex(chat);

    for (let i = startIdx; i <= endIdx; i++) {
        const message = chat[i];
        if (!isPassageCountableMessage(message)) {
            continue;
        }
        addBudgetStats(stats, await countBudgetMessage(message, promptDepths.get(i), settings));
    }

    return stats;
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

async function countBudgetMessage(message, depth, settings) {
    const rawText = String(message.mes || '').trim();
    const finalText = await getBudgetMessageText(message, rawText, depth, settings);
    const rawLine = getBudgetMessageLine(message, rawText);
    const finalLine = getBudgetMessageLine(message, finalText);
    const tokens = await countMessageTokens(message, rawLine, finalLine);

    return {
        rawTokens: tokens.rawTokens,
        finalTokens: tokens.finalTokens,
        rawTokensEstimated: tokens.rawTokensEstimated,
        finalTokensEstimated: tokens.finalTokensEstimated,
        changed: rawLine !== finalLine,
    };
}

async function getBudgetMessageText(message, rawText, depth, settings) {
    if (!settings.applyRegexScripts) {
        return rawText;
    }
    return await applyRegexToMessage(rawText, Boolean(message.is_user), depth);
}

function getBudgetMessageLine(message, text) {
    const speaker = message.is_user ? 'Player' : 'Assistant';
    return `${speaker}: ${text}`;
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

function isPromptVisibleMessage(message) {
    if (!message?.mes || !String(message.mes).trim()) {
        return false;
    }
    if (message.extra?.sc_ghosted) {
        return false;
    }
    return !message.is_system && !message.is_hidden;
}

function isPassageCountableMessage(message) {
    if (!message?.mes || !String(message.mes).trim()) {
        return false;
    }
    return !(message.is_system || message.is_hidden) || message.extra?.sc_ghosted;
}
