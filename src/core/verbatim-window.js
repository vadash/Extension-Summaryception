import { getAssistantTurns, getPromptDepthsByChatIndex, iterateChatRange } from './chatutils.js';
import { applyRegexToMessage } from './regex-proxy.js';
import { addBudgetStats, countMessageTokens, createBudgetStats } from './token-count.js';
import { buildLayer0Partitions } from './partition-planner.js';

/**
 * @typedef {object} Layer0OverflowPlan
 * @property {import('./chatutils.js').AssistantTurn[]} visibleTurns - Assistant turns currently visible in live chat.
 * @property {import('./chatutils.js').AssistantTurn[]} eligibleTurns - Visible assistant turns after the summary cursor.
 * @property {import('./chatutils.js').AssistantTurn[]} batchTurns - Assistant turns selected for the next Layer 0 batch.
 * @property {import('./partition-planner.js').SourcePartition[]} partitions - Token-balanced source partitions for eligible turns.
 * @property {'budget' | 'max' | 'force' | 'repair' | 'none'} reason - Trigger that selected the plan.
 * @property {number} overflowCount - Total eligible assistant turns outside the verbatim window.
 * @property {number} softOverflowCount - Overflow turns not selected in the current batch.
 * @property {number} visibleTurnCount - Count of currently visible assistant turns.
 * @property {number} tokenBoundaryIndex - Oldest chat index beyond the verbatim token budget.
 * @property {import('./token-count.js').BudgetStats} budgetStats - Token stats for the live verbatim window.
 * @property {import('./token-count.js').BudgetStats} summaryStats - Token stats for the selected summary source.
 * @property {boolean} tokenBudgetExceeded - Whether live chat exceeds the verbatim token budget.
 */

/**
 * @typedef {object} VerbatimWindowSettings
 * @property {number} minSummaryTurns - Minimum assistant turns required for automatic summary.
 * @property {number} maxSummaryTurns - Maximum assistant turns per Layer 0 batch.
 * @property {number} minSummaryBudget - Minimum source tokens required for automatic summary.
 * @property {number} verbatimTokenBudget - Live-context token ceiling.
 * @property {boolean} applyRegexScripts - Whether regex scripts apply while counting source text.
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
    const data = await buildOverflowPlanData(chat, store, settings);

    if (data.candidateTurns.length >= settings.maxSummaryTurns) {
        return await buildPartitionedOverflowPlan({
            ...data,
            reason: 'max',
            sourceTurns: data.candidateTurns,
            getBatchTurns: (partitions) => partitions[0]?.turns || data.candidateTurns,
        });
    }

    const partitions = await buildOverflowPartitions(data, data.overflowTurns);
    const summaryStats = partitions[0]?.stats || createBudgetStats();

    if (ignoreReadiness && data.candidateTurns.length > 0) {
        return buildPlanFromData(data, {
            reason: 'force',
            batchTurns: data.candidateTurns,
            partitions,
            summaryStats,
        });
    }

    if (
        data.candidateTurns.length >= settings.minSummaryTurns &&
        summaryStats.finalTokens >= settings.minSummaryBudget
    ) {
        return buildPlanFromData(data, {
            reason: 'budget',
            batchTurns: data.candidateTurns,
            partitions,
            summaryStats,
        });
    }

    if (data.budget.exceeded && data.eligibleTurns.length === 0) {
        return buildPlanFromData(data, {
            reason: 'repair',
            batchTurns: [],
            partitions: [],
            summaryStats,
        });
    }

    return buildPlanFromData(data, {
        reason: 'none',
        batchTurns: [],
        partitions: [],
        summaryStats,
    });
}

function getVisibleAssistantTurns(chat) {
    return getAssistantTurns(chat).filter((turn) => !chat[turn.index]?.extra?.sc_ghosted);
}

async function buildOverflowPlanData(chat, store, settings) {
    const visibleTurns = getVisibleAssistantTurns(chat);
    const eligibleTurns = visibleTurns.filter((turn) => turn.index > store.summarizedUpTo);
    const budget = await getTokenBudgetBoundary(chat, settings);
    const overflowTurns = eligibleTurns.filter((turn) => turn.index <= budget.boundaryIndex);

    return {
        chat,
        settings,
        sourceStartIdx: getPassageStart(store),
        visibleTurns,
        eligibleTurns,
        overflowTurns,
        candidateTurns: overflowTurns.slice(0, Math.max(1, settings.maxSummaryTurns)),
        budget,
    };
}

async function buildPartitionedOverflowPlan({ reason, sourceTurns, getBatchTurns, ...data }) {
    const partitions = await buildOverflowPartitions(data, sourceTurns);
    return buildPlanFromData(data, {
        reason,
        batchTurns: getBatchTurns(partitions),
        partitions,
        summaryStats: partitions[0]?.stats || createBudgetStats(),
    });
}

async function buildOverflowPartitions(data, assistantTurns) {
    return await buildLayer0Partitions({
        chat: data.chat,
        sourceStartIdx: data.sourceStartIdx,
        assistantTurns,
        settings: data.settings,
    });
}

function buildPlanFromData(data, overrides) {
    return buildPlan({
        visibleTurns: data.visibleTurns,
        eligibleTurns: data.eligibleTurns,
        overflowTurns: data.overflowTurns,
        budget: data.budget,
        ...overrides,
    });
}

function buildPlan({
    reason,
    visibleTurns,
    eligibleTurns,
    overflowTurns,
    batchTurns,
    partitions,
    budget,
    summaryStats,
}) {
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
