import { getCurrentSummarizedBoundary } from './snippet-provenance.js';
import { countedChatMessages, toAssistantTurn } from './chatutils.js';
import { readSealedMicrofichePlans } from './microfiche-pages.js';
import { buildLayer0Partitions } from './partition-planner.js';
import { addBudgetStats, createBudgetStats } from './token-count.js';

/**
 * @typedef {object} ChatWindowPlan
 * @property {'ready' | 'force' | 'repair' | 'none'} reason Window state this plan represents.
 * @property {number} sourceStartIdx First chat index eligible for summarization (summarized boundary + 1).
 * @property {number} queuedEndIdx Last assistant turn index inside the queued window, or -1 when empty.
 * @property {number} verbatimStartIdx First chat index kept verbatim after the queued window.
 * @property {import('./chatutils.js').AssistantTurn[]} visibleTurns Assistant turns in the live chat window.
 * @property {import('./chatutils.js').AssistantTurn[]} eligibleTurns Visible turns before the verbatim start, queued for summarization.
 * @property {import('./chatutils.js').AssistantTurn[]} batchTurns Turns of the first partition, that is, the current summarization batch.
 * @property {import('./partition-planner.js').SourcePartition[]} partitions Layer-0 source partitions covering the queued window.
 * @property {number} overflowCount Number of eligible turns awaiting summarization.
 * @property {number} softOverflowCount Eligible turns beyond the current batch.
 * @property {number} visibleTurnCount Number of assistant turns in the live window.
 * @property {import('./token-count.js').BudgetStats} liveStats Budget stats for the full live window.
 * @property {import('./token-count.js').BudgetStats} verbatimStats Budget stats for the verbatim tail.
 * @property {import('./token-count.js').BudgetStats} queuedStats Budget stats for the queued window.
 * @property {number} liveTokens Final token count of the live window.
 * @property {number} verbatimTokens Final token count of the verbatim tail.
 * @property {number} queuedTokens Final token count of the queued window.
 * @property {number} verbatimBudget Configured verbatim token budget.
 * @property {number} queuedBudget Configured queued token budget.
 * @property {boolean} tokenBudgetExceeded True when live tokens reach the combined verbatim and queued budgets.
 */

/**
 * Coerce a settings budget to a number, falling back to 0 when unset or invalid.
 * @param {unknown} value
 * @returns {number}
 */
const toTokenBudget = (value) => Number(value) || 0;
/**
 * Build one explicit recent/queued chat window plan for every automatic memory mode.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {ExtensionSettings} settings
 * @param {{ ignoreReadiness?: boolean }} [opts]
 * @returns {Promise<ChatWindowPlan>}
 */
export async function buildChatWindowPlan(chat, store, settings, { ignoreReadiness = false } = {}) {
    const boundary = getCurrentSummarizedBoundary(chat, store);
    const sourceStartIdx = boundary + 1;
    const data = await collectLiveData(chat, sourceStartIdx, settings);
    const verbatimBudget = toTokenBudget(settings.verbatimTokenBudget);
    const queuedBudget = toTokenBudget(settings.queuedTokenBudget);
    const rawSpend = readRawImageSpend(settings);
    const tokenBudgetExceeded = exceedsTriggerBudget(
        data.liveStats.finalTokens,
        rawSpend,
        verbatimBudget + queuedBudget,
    );
    const verbatimStartIdx = findVerbatimStart(data.entries, verbatimBudget, sourceStartIdx);
    const eligibleTurns = data.visibleTurns.filter((turn) => turn.index < verbatimStartIdx);
    const queuedEndIdx = eligibleTurns.at(-1)?.index ?? -1;
    const verbatimStats = getEntryStats(data.entries, verbatimStartIdx, chat.length - 1);
    const queuedStats = getEntryStats(data.entries, sourceStartIdx, queuedEndIdx);
    const shared = {
        sourceStartIdx,
        verbatimStartIdx,
        visibleTurns: data.visibleTurns,
        liveStats: data.liveStats,
        verbatimStats,
        verbatimBudget,
        queuedBudget,
        tokenBudgetExceeded,
    };
    const empty = (reason = /** @type {ChatWindowPlan['reason']} */ ('none')) =>
        buildPlan({ ...shared, queuedEndIdx, eligibleTurns, queuedStats, reason, partitions: [] });
    const readyBase = { chat, settings, ...shared, queuedEndIdx, eligibleTurns, queuedStats };

    if (data.entries.length === 0 || sourceStartIdx >= chat.length) {
        return empty();
    }

    if (ignoreReadiness) {
        if (data.visibleTurns.length === 0 || eligibleTurns.length === 0) {
            return empty();
        }
        return await buildReadyPlan({
            ...readyBase,
            reason: 'force',
        });
    }

    if (!tokenBudgetExceeded) {
        return empty();
    }
    if (eligibleTurns.length === 0) {
        return empty('repair');
    }
    const latestEntry = data.entries.at(-1);
    if (
        !latestEntry ||
        latestEntry.message.is_user ||
        eligibleTurns.length < settings.minSummaryTurns
    ) {
        return empty();
    }

    return await buildReadyPlan({ ...readyBase, reason: 'ready' });
}
/**
 * The trigger line counts raw image spend against the shared bucket, and an
 * over-cap raw plan asks for memory even when the text alone still fits.
 * @param {number} liveTokens - Live window text tokens.
 * @param {{ overCap: boolean, imageTokens: number }} rawSpend - Raw image spend.
 * @param {number} bucketTokens - Combined verbatim and queued budget.
 * @returns {boolean} Whether summarization should run.
 */
function exceedsTriggerBudget(liveTokens, rawSpend, bucketTokens) {
    return rawSpend.overCap || liveTokens + rawSpend.imageTokens >= bucketTokens;
}

/**
 * The frozen-raw region's share of the trigger: the image tokens the writer's
 * sealed plan bills and whether a fill-gated page missed the image cap. Reading
 * the seal keeps the trigger on the same pages the prompt writer bound; a
 * writer update that has not run since the last chat growth leaves the previous
 * seal in place. Over-cap means the next full image would not fit, so the
 * engine runs a memory update instead of adding that image (ADR-0045). Off or
 * plan-less regions spend nothing.
 * @param {ExtensionSettings} settings
 * @returns {{ overCap: boolean, imageTokens: number }}
 */
function readRawImageSpend(settings) {
    if (settings?.microficheFrozenRawImages !== true) {
        return { overCap: false, imageTokens: 0 };
    }
    const plan = readSealedMicrofichePlans()?.microficheRaw;
    if (plan === null || plan === undefined) {
        return { overCap: false, imageTokens: 0 };
    }
    return {
        overCap: plan.overCap === true,
        imageTokens: plan.imageTexts.length * plan.frameTokenEstimate,
    };
}

/**
 * @typedef {{ index: number, message: ChatMessage, stats: import('./token-count.js').CountedBudgetMessage }} LiveEntry
 * @typedef {{ entries: LiveEntry[], liveStats: import('./token-count.js').BudgetStats, visibleTurns: import('./chatutils.js').AssistantTurn[] }} LiveData
 * @typedef {Omit<ChatWindowPlan, 'batchTurns' | 'partitions' | 'overflowCount' | 'softOverflowCount' | 'visibleTurnCount' | 'liveTokens' | 'verbatimTokens' | 'queuedTokens'> & { chat: ChatMessage[], settings: ExtensionSettings }} ReadyPlanData
 */

/**
 * @param {ChatMessage[]} chat
 * @param {number} sourceStartIdx
 * @param {ExtensionSettings} settings
 * @returns {Promise<LiveData>}
 */
async function collectLiveData(chat, sourceStartIdx, settings) {
    const liveStats = createBudgetStats();
    const entries = [];
    const visibleTurns = [];

    for await (const { index, message, stats } of countedChatMessages(
        chat,
        sourceStartIdx,
        chat.length - 1,
        { settings },
    )) {
        addBudgetStats(liveStats, stats);
        entries.push({ index, message, stats });
        if (!message.is_user) {
            visibleTurns.push(toAssistantTurn(message, index));
        }
    }

    return { entries, liveStats, visibleTurns };
}

/**
 * Fraction of the verbatim budget the cut leaves as trigger headroom. The cut
 * line sits inside the budget, so a finished run lands below the full-budget
 * trigger line and token-count jitter cannot re-queue whole turns.
 * @constant {number}
 */
const VERBATIM_CUT_MARGIN = 0.1;

/**
 * Find the verbatim window start by walking backward until the margined budget
 * fills. The crossing entry joins the window whole, so the window stays below
 * the configured budget while summarization cuts ~10% deeper than the exact
 * budget line.
 * @param {LiveEntry[]} entries
 * @param {number} budget
 * @param {number} fallback
 * @returns {number}
 */
function findVerbatimStart(entries, budget, fallback) {
    const cutTarget = budget * (1 - VERBATIM_CUT_MARGIN);
    let tokens = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        tokens += entry.stats.finalTokens;
        if (tokens >= cutTarget) {
            return entry.index;
        }
    }
    return entries[0]?.index ?? fallback;
}

/**
 * @param {LiveEntry[]} entries
 * @param {number} startIdx
 * @param {number} endIdx
 * @returns {import('./token-count.js').BudgetStats}
 */
function getEntryStats(entries, startIdx, endIdx) {
    const stats = createBudgetStats();
    if (endIdx < startIdx) {
        return stats;
    }
    for (const entry of entries) {
        if (entry.index >= startIdx && entry.index <= endIdx) {
            addBudgetStats(stats, entry.stats);
        }
    }
    return stats;
}

/**
 * @param {ReadyPlanData} data
 * @returns {Promise<ChatWindowPlan>}
 */
async function buildReadyPlan(data) {
    const partitions = await buildLayer0Partitions({
        chat: data.chat,
        sourceStartIdx: data.sourceStartIdx,
        assistantTurns: data.eligibleTurns,
        settings: data.settings,
        finalSourceEndIdx: data.queuedEndIdx,
    });
    return buildPlan({ ...data, partitions });
}

function buildPlan({
    reason,
    sourceStartIdx,
    queuedEndIdx,
    verbatimStartIdx,
    visibleTurns,
    eligibleTurns,
    partitions,
    liveStats,
    verbatimStats,
    queuedStats,
    verbatimBudget,
    queuedBudget,
    tokenBudgetExceeded,
}) {
    const batchTurns = partitions[0]?.turns || [];
    return {
        reason,
        sourceStartIdx,
        queuedEndIdx,
        verbatimStartIdx,
        visibleTurns,
        eligibleTurns,
        batchTurns,
        partitions,
        overflowCount: eligibleTurns.length,
        softOverflowCount: Math.max(0, eligibleTurns.length - batchTurns.length),
        visibleTurnCount: visibleTurns.length,
        liveStats,
        verbatimStats,
        queuedStats,
        liveTokens: liveStats.finalTokens,
        verbatimTokens: verbatimStats.finalTokens,
        queuedTokens: queuedStats.finalTokens,
        verbatimBudget,
        queuedBudget,
        tokenBudgetExceeded,
    };
}
