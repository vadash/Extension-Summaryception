import { NOTIFY_EVENTS } from '../foundation/constants.js';
import { warn } from '../foundation/logger.js';
import { getChatStore } from '../foundation/state.js';
import { getEffectiveMemoryUsage } from './memory-budget.js';
import { getLayer0SummaryTokenTarget } from './layer0-compression.js';
import {
    buildHypotheticalLayersAfterPromotion,
    getPromotionSummaryTokenHardMax,
    getPromotionSummaryTokenTarget,
} from './promotion-planner.js';
import { isSummarizerOutputSafe } from './summarizer-output.js';
import { buildRepairDiagnostics } from './repair-diagnostics.js';
import { callSummarizer } from './summarizer-request.js';
import {
    formatSnippetAnchor,
    parseSnippet,
    stripLeadingSnippetAnchor,
} from './snippet-metadata.js';
import { countTextTokens, formatTokenValue } from './token-count.js';

/**
 * Generate one validated promotion snippet: request the merge, validate size
 * and integrity, run at most one section-aware repair pass, and require the
 * result to compress the live store's memory.
 * @param {object} prepared - Request-facing promotion fields (no snapshot).
 * @param {number} prepared.layerIndex - Promotion SOURCE layer.
 * @param {number} prepared.mergeCount
 * @param {ExtensionSettings} prepared.settings
 * @param {Array<object>} prepared.toMerge
 * @param {string} prepared.sourceNarrativeText
 * @param {{ count: number, estimated: boolean }} prepared.memoryTokensBefore
 * @param {string} prepared.storyTxt
 * @param {string} prepared.contextStr
 * @param {object} prepared.promotedMetadata
 * @param {object} prepared.promotionMetadata
 * @param {import('./notify.js').NotifyAdapter} [notify] - Notify adapter; runs without one stay silent.
 * @returns {Promise<object | null>} The promoted snippet, or null when rejected.
 */
export async function generateValidatedPromotion(prepared, notify) {
    notify?.transient({
        kind: NOTIFY_EVENTS.PROMOTION_STARTED,
        mergedCount: prepared.toMerge.length,
        fromLayer: prepared.layerIndex,
        toLayer: prepared.layerIndex + 1,
    });

    if (!prepared.storyTxt) {
        return null;
    }

    const metaOutcome = await callSummarizer(
        prepared.storyTxt,
        prepared.contextStr,
        prepared.promotionMetadata,
        notify,
    );
    if (metaOutcome.status !== 'completed') {
        return null;
    }

    return await buildValidatedPromotionSnippet({
        prepared,
        narrative: metaOutcome.text,
        profile: metaOutcome.profile,
        notify,
    });
}

async function buildValidatedPromotionSnippet({ prepared, narrative, profile, notify }) {
    const {
        layerIndex,
        mergeCount,
        settings,
        sourceNarrativeText,
        memoryTokensBefore: sourceTokens,
        storyTxt,
        contextStr,
        promotionMetadata: metadata,
        promotedMetadata,
    } = prepared;
    const firstCandidate = buildPromotionCandidate(narrative, promotedMetadata);
    if (!firstCandidate) {
        return null;
    }

    const firstValidation = await validatePromotionCandidate({
        layerIndex,
        mergeCount,
        promotedSnippet: firstCandidate,
        settings,
        sourceNarrativeText,
        sourceTokens,
        profile,
    });
    if (firstValidation.valid) {
        return firstCandidate;
    }

    if (
        (firstValidation.reason !== 'compression-ratio' &&
            firstValidation.reason !== 'too-short') ||
        !firstValidation.outputTokens ||
        !firstValidation.sourceTokens
    ) {
        return null;
    }

    const repairOutcome = await callSummarizer(
        storyTxt,
        contextStr,
        {
            ...metadata,
            promotionRepair: {
                reason: firstValidation.reason,
                outputTokens: firstValidation.outputTokens.count,
                targetTokens: firstValidation.targetTokens,
                hardMaxTokens: firstValidation.hardMaxTokens,
                requiredMaxTokens: firstValidation.requiredMaxTokens,
                sourceTokens: firstValidation.sourceTokens.count,
                rejectedSummary: firstCandidate.text,
                diagnostics: firstValidation.diagnostics,
            },
        },
        notify,
    );
    if (repairOutcome.status !== 'completed') {
        return null;
    }
    const repairedCandidate = buildPromotionCandidate(repairOutcome.text, promotedMetadata);
    if (!repairedCandidate) {
        return null;
    }

    const repairedValidation = await validatePromotionCandidate({
        layerIndex,
        mergeCount,
        promotedSnippet: repairedCandidate,
        settings,
        sourceNarrativeText,
        sourceTokens,
        profile: repairOutcome.profile,
    });
    return repairedValidation.valid ? repairedCandidate : null;
}

function buildPromotionCandidate(narrative, promotedMetadata) {
    const metaSummary = parseSnippet(narrative).narrative.trim();
    if (!metaSummary) {
        return null;
    }
    const cleanSummary = formatSnippetAnchor(promotedMetadata)
        ? stripLeadingSnippetAnchor(metaSummary)
        : metaSummary;
    if (!cleanSummary) {
        return null;
    }
    return { text: cleanSummary, ...promotedMetadata };
}

async function validatePromotionCandidate({
    layerIndex,
    mergeCount,
    promotedSnippet,
    settings,
    sourceNarrativeText,
    sourceTokens: providedSourceTokens,
    profile,
}) {
    const sourceTokens = providedSourceTokens || (await countTextTokens(sourceNarrativeText));
    const sizeValidation = await validatePromotionSize({
        layerIndex,
        promotedSnippet,
        settings,
        sourceTokens,
        profile,
    });
    if (!sizeValidation.valid) {
        return sizeValidation;
    }
    return validatePromotionCompressesMemory({ layerIndex, mergeCount, promotedSnippet, settings });
}

async function validatePromotionSize({
    layerIndex,
    promotedSnippet,
    settings,
    sourceTokens,
    profile,
}) {
    if (!isPromotionSummarySafe({ layerIndex, promotedSnippet, profile })) {
        return { valid: false, reason: 'integrity' };
    }
    const outputTokens = await countTextTokens(promotedSnippet.text);
    const targetTokens = getLayer0SummaryTokenTarget(settings);
    const minTokens = getPromotionSummaryTokenTarget({ layerIndex, targetTokens });
    const hardMaxTokens = getPromotionSummaryTokenHardMax({ layerIndex, targetTokens });
    const tooShort = outputTokens.count < minTokens;
    if (outputTokens.count > hardMaxTokens || tooShort) {
        return rejectPromotionSize({
            layerIndex,
            promotedSnippet,
            sourceTokens,
            outputTokens,
            minTokens,
            hardMaxTokens,
            tooShort,
        });
    }
    return { valid: true };
}

async function validatePromotionCompressesMemory({
    layerIndex,
    mergeCount,
    promotedSnippet,
    settings,
}) {
    const store = getChatStore();
    const memoryTokensBefore = await getEffectiveMemoryUsage(store.layers, settings);
    const nextLayers = buildHypotheticalLayersAfterPromotion(
        store.layers,
        layerIndex,
        mergeCount,
        promotedSnippet,
    );
    const memoryTokensAfter = await getEffectiveMemoryUsage(nextLayers, settings);
    if (memoryTokensAfter.total.count < memoryTokensBefore.total.count) {
        return { valid: true };
    }
    warn(
        `Promotion L${layerIndex} rejected: memory did not compress ` +
            `(${formatTokenValue(
                memoryTokensBefore.total.count,
                memoryTokensBefore.total.estimated,
            )}->` +
            `${formatTokenValue(
                memoryTokensAfter.total.count,
                memoryTokensAfter.total.estimated,
            )} tokens).`,
    );
    return { valid: false, reason: 'memory-total' };
}

function isPromotionSummarySafe({ layerIndex, promotedSnippet, profile }) {
    return isSummarizerOutputSafe(
        promotedSnippet.text,
        profile,
        `Promotion L${layerIndex} rejected: `,
    );
}

function rejectPromotionSize({
    layerIndex,
    promotedSnippet,
    sourceTokens,
    outputTokens,
    minTokens,
    hardMaxTokens,
    tooShort,
}) {
    const diagnostics = buildRepairDiagnostics({
        scope: 'Layer 1+ promotion',
        totalTokens: outputTokens.count,
        sections: [
            {
                id: 'draft',
                label: '[NARRATIVE]',
                actualTokens: outputTokens.count,
                targetTokens: minTokens,
                hardMaxTokens,
                ...(tooShort ? { minimumTokens: minTokens } : {}),
                text: promotedSnippet.text,
                repairInstruction: tooShort
                    ? 'expand the fold: it over-merged; restore the dropped durable beats'
                    : 'rewrite as macro-level prose only; remove dialogue, scene replay, micro-actions, and transient detail',
                preservationInstruction:
                    'retain only macro-level durable chronology and continuity',
            },
        ],
        rejectedDraft: promotedSnippet.text,
    });
    warn(
        tooShort
            ? `Promotion L${layerIndex} rejected: output under the over-merge floor ` +
                  `(${formatTokenValue(sourceTokens.count, sourceTokens.estimated)}->` +
                  `${formatTokenValue(outputTokens.count, outputTokens.estimated)} tokens; ` +
                  `minimum ${formatTokenValue(minTokens, sourceTokens.estimated)}).`
            : `Promotion L${layerIndex} rejected: output exceeded the compression hard maximum ` +
                  `(${formatTokenValue(sourceTokens.count, sourceTokens.estimated)}->` +
                  `${formatTokenValue(outputTokens.count, outputTokens.estimated)} tokens; ` +
                  `target ${formatTokenValue(minTokens, sourceTokens.estimated)}, ` +
                  `hard maximum ${formatTokenValue(hardMaxTokens, sourceTokens.estimated)}).`,
    );
    return {
        valid: false,
        reason: tooShort ? 'too-short' : 'compression-ratio',
        sourceTokens,
        outputTokens,
        targetTokens: minTokens,
        hardMaxTokens,
        requiredMaxTokens: hardMaxTokens,
        diagnostics,
    };
}
