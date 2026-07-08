import { getAssistantTurns, getPromptDepthsByChatIndex, iterateChatRange } from './chatutils.js';
import { applyRegexToMessage } from './regex-proxy.js';
import { addBudgetStats, countMessageTokens, createBudgetStats } from './token-count.js';
import { buildLayer0Partitions } from './partition-planner.js';

/**
 * @typedef {object} Layer0OverflowPlan
 * @property {import('./chatutils.js').AssistantTurn[]} visibleTurns
 * @property {import('./chatutils.js').AssistantTurn[]} eligibleTurns
 * @property {import('./chatutils.js').AssistantTurn[]} batchTurns
 * @property {import('./partition-planner.js').SourcePartition[]} partitions
 * @property {'budget' | 'max' | 'force' | 'repair' | 'none'} reason
 * @property {number} overflowCount - Total eligible assistant turns outside the verbatim window.
 * @property {number} softOverflowCount - Overflow turns not selected in the current batch.
 * @property {number} visibleTurnCount
 * @property {number} tokenBoundaryIndex
 * @property {import('./token-count.js').BudgetStats} budgetStats
 * @property {import('./token-count.js').BudgetStats} summaryStats
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
 * @param {ExtensionSettings} settings
 * @param {{ ignoreReadiness?: boolean }} [opts]
 * @returns {Promise<Layer0OverflowPlan>}
 */
export async function getLayer0OverflowPlan(
    chat,
    store,
    settings,
    { ignoreReadiness = false } = {},
) {
    const visibleTurns = getVisibleAssistantTurns(chat);
    const eligibleTurns = visibleTurns.filter((turn) => turn.index > store.summarizedUpTo);
    const budget = await getTokenBudgetBoundary(chat, settings);
    const overflowTurns = eligibleTurns.filter((turn) => turn.index <= budget.boundaryIndex);
    const candidateTurns = overflowTurns.slice(0, Math.max(1, settings.maxSummaryTurns));

    if (candidateTurns.length >= settings.maxSummaryTurns) {
        const partitions = await buildLayer0Partitions(
            chat,
            getPassageStart(store),
            candidateTurns,
            settings,
        );
        const summaryStats = partitions[0]?.stats || createBudgetStats();

        return buildPlan(
            'max',
            visibleTurns,
            eligibleTurns,
            overflowTurns,
            partitions[0]?.turns || candidateTurns,
            partitions,
            budget,
            summaryStats,
        );
    }

    const partitions = await buildLayer0Partitions(
        chat,
        getPassageStart(store),
        overflowTurns,
        settings,
    );
    const summaryStats = partitions[0]?.stats || createBudgetStats();

    if (ignoreReadiness && candidateTurns.length > 0) {
        return buildPlan(
            'force',
            visibleTurns,
            eligibleTurns,
            overflowTurns,
            candidateTurns,
            partitions,
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
            partitions,
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
            [],
            budget,
            summaryStats,
        );
    }

    return buildPlan(
        'none',
        visibleTurns,
        eligibleTurns,
        overflowTurns,
        [],
        [],
        budget,
        summaryStats,
    );
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
    partitions,
    budget,
    summaryStats,
) {
    return {
        visibleTurns,
        eligibleTurns,
        batchTurns,
        partitions,
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
    for (const { index, message } of iterateChatRange(chat, chat.length - 1, 0)) {
        if (!isPromptVisibleMessage(message)) {
            continue;
        }

        const counted = await countBudgetMessage(message, promptDepths.get(index), settings);
        addBudgetStats(stats, counted);
        totalTokens += counted.finalTokens;
        if (!exceeded && totalTokens > settings.verbatimTokenBudget) {
            exceeded = true;
            boundaryIndex = index;
        }
    }

    return { boundaryIndex, exceeded, stats };
}

function getPassageStart(store) {
    return store.summarizedUpTo < 0 ? 0 : store.summarizedUpTo + 1;
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

function isPromptVisibleMessage(message) {
    if (!message?.mes || !String(message.mes).trim()) {
        return false;
    }
    if (message.extra?.sc_ghosted) {
        return false;
    }
    return !message.is_system && !message.is_hidden;
}
