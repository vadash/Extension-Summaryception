import { getContext } from '../foundation/context.js';
import { getChatStore } from '../foundation/chat-store.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { debug } from '../foundation/logger.js';
import { buildFullContext } from './chatutils.js';
import { generateValidatedPromotion } from './promotion-candidate.js';
import { buildPromotionPlan } from './promotion-planner.js';
import {
    buildPromotedSnippetMetadata,
    formatAnchoredSnippetNarrative,
} from './snippet-metadata.js';
import { commitSnippetMutation } from './snippet-commit.js';
import { buildSnapshotBasis, isSnapshotStoreCurrent } from './summarizer-snapshot.js';
import { countTextTokens } from './token-count.js';

/**
 * @param {object} plan - Promotion plan from buildPromotionPlan.
 * @param {ExtensionSettings} s - Effective settings.
 * @param {object} p - The notify adapter, Foreground Gate, and summarizer dispatch the merge runs through.
 * @param {import('./notify.js').NotifyAdapter | undefined} p.notify - Notify adapter threaded from the drain; runs without one stay silent.
 * @param {import('./foreground-gate.js').ForegroundGate} p.gate - Foreground Gate the merge commit crosses.
 * @param {import('./summarizer-request.js').SummarizerDispatch['call']} p.dispatch - Summarizer Dispatch the merge requests through.
 * @returns {Promise<boolean>} Whether the promotion merged and committed.
 */
async function attemptPromotion(plan, s, { notify, gate, dispatch }) {
    return await mergeLayerSnippets({ plan, candidate: plan.candidate, s, notify, gate, dispatch });
}

/**
 * @param {object} p
 * @param {object} p.plan - Promotion plan supplying the merge count and retention-floor verdict.
 * @param {{ layerIndex: number, quota: number, tokens: number, count: number }} p.candidate - Over-limit layer from the plan.
 * @param {ExtensionSettings} p.s
 * @param {import('./notify.js').NotifyAdapter} [p.notify] - Notify adapter; runs without one stay silent.
 * @param {import('./foreground-gate.js').ForegroundGate} p.gate - Foreground Gate the merge commit crosses.
 * @param {import('./summarizer-request.js').SummarizerDispatch['call']} p.dispatch - Summarizer Dispatch the merge requests through.
 * @returns {Promise<boolean>}
 */
async function mergeLayerSnippets({ plan, candidate, s, notify, gate, dispatch }) {
    const outcome = await prepareLayerPromotion({
        layerIndex: candidate.layerIndex,
        settings: s,
        quota: candidate.quota,
        layerTokens: candidate.tokens,
        layerCount: candidate.count,
        mergeCount: plan.mergeCount,
        retentionFloorViolated: plan.retentionFloorViolated,
    });
    if (!outcome) {
        return false;
    }

    const promotedSnippet = await generateValidatedPromotion(outcome.prepared, {
        notify,
        dispatch,
    });
    if (!promotedSnippet) {
        return false;
    }

    return await commitValidatedPromotion({
        prepared: outcome.prepared,
        snapshot: outcome.snapshot,
        promotedSnippet,
        gate,
    });
}

/**
 * @param {object} p
 * @param {number} p.layerIndex
 * @param {ExtensionSettings} p.settings
 * @param {number} p.quota
 * @param {number} p.layerTokens
 * @param {number} p.layerCount
 * @param {number} p.mergeCount - Effective promotion batch size from the plan.
 * @param {boolean} p.retentionFloorViolated - Plan verdict: promoting would breach the Layer 0 retention floor.
 * @returns {Promise<{ prepared: object, snapshot: object } | null>} Request-facing inputs plus the transaction snapshot, or null when the layer cannot be promoted.
 */
async function prepareLayerPromotion({
    layerIndex,
    settings,
    quota,
    layerTokens,
    layerCount,
    mergeCount,
    retentionFloorViolated,
}) {
    const store = getChatStore();
    const layer = store.layers[layerIndex] || [];
    const toMerge = layer.slice(0, mergeCount);
    if (toMerge.length < mergeCount) {
        return null;
    }

    if (retentionFloorViolated) {
        debug('L0 promotion skipped: projected L0 memory would fall below 40% of quota.');
        return null;
    }

    const storyTxt = toMerge
        .map((snippet) => formatAnchoredSnippetNarrative(snippet))
        .filter(Boolean)
        .join('\n\n');
    const sourceNarrativeText = storyTxt;
    const memoryTokensBefore = await countTextTokens(storyTxt);
    const contextStr = buildFullContext(layerIndex + 1);
    const promotedMetadata = buildPromotedSnippetMetadata(toMerge);
    const snapshot = {
        ...capturePromotionSnapshot(layerIndex),
        mergeCount: toMerge.length,
        storyTxt: sourceNarrativeText,
        contextStr,
        promotedMetadata,
    };
    const promotionMetadata = {
        kind: 'promotion',
        layerIndex,
        mergedSnippetCount: toMerge.length,
        memoryTokensBefore: memoryTokensBefore.count,
        memoryTokensBeforeEstimated: memoryTokensBefore.estimated,
        overflowLayerIndex: layerIndex,
        overflowMemoryCount: layerCount,
        overflowMemoryLimit: settings.snippetsPerLayer,
        overflowTokens: layerTokens,
        overflowTokenQuota: quota,
    };

    return {
        prepared: {
            layerIndex,
            mergeCount,
            settings,
            toMerge,
            sourceNarrativeText,
            memoryTokensBefore,
            storyTxt,
            contextStr,
            promotedMetadata,
            promotionMetadata,
        },
        snapshot,
    };
}

async function commitValidatedPromotion({ prepared, snapshot, promotedSnippet, gate }) {
    const result = await gate.commitWhenSafe({
        kind: 'promotion-merge',
        apply: async () =>
            applyMergePromotion({
                snapshot,
                layerIndex: prepared.layerIndex,
                promotedSnippet,
            }),
    });

    return result !== 'stale';
}

/**
 * Capture summary-store state for a promotion transaction.
 * @param {number} layerIndex
 * @returns {object}
 */
function capturePromotionSnapshot(layerIndex) {
    const ctx = getContext();
    const store = getChatStore();

    return {
        ...buildSnapshotBasis({ chatRef: ctx.chat, store, ctx }),
        layerIndex,
    };
}

/**
 * @param {object} p
 * @param {object} p.snapshot
 * @param {number} p.layerIndex
 * @param {object} p.promotedSnippet
 * @returns {Promise<boolean>}
 */
async function applyMergePromotion({ snapshot, layerIndex, promotedSnippet }) {
    if (!isSnapshotStoreCurrent(snapshot, getContext(), getChatStore())) {
        return false;
    }

    const store = getChatStore();
    const layer = store.layers[layerIndex] || [];
    if (layer.length < snapshot.mergeCount) {
        return false;
    }

    await commitSnippetMutation(
        store,
        () => {
            const toMerge = layer.splice(0, snapshot.mergeCount);
            const destLayer = store.layers[layerIndex + 1] || [];
            destLayer.push({
                ...promotedSnippet,
                fromLayer: layerIndex,
                mergedCount: toMerge.length,
                timestamp: Date.now(),
            });
            store.layers[layerIndex + 1] = destLayer;
        },
        { ghost: 'none' },
    );

    return true;
}

/**
 * Drain promotion overflow: the single loop that owns overflow clearing.
 * Repeatedly promotes the shallowest over-limit layer until layers fit, the
 * retention floor refuses the candidate, the Foreground Gate blocks, or
 * consecutive failed promotions reach `maxConsecutiveFailures`.
 * @param {object} options
 * @param {number} [options.maxConsecutiveFailures] - Consecutive failed promotions tolerated before stopping.
 * @param {import('./notify.js').NotifyAdapter} [options.notify] - Notify adapter threaded from the engine; runs without one stay silent.
 * @param {import('./foreground-gate.js').ForegroundGate} options.gate - Foreground Gate the drain asks before and after every attempt.
 * @param {import('./summarizer-request.js').SummarizerDispatch['call']} options.dispatch - Summarizer Dispatch every promotion request goes through.
 * @returns {Promise<{status: 'completed', attempts: number} | {status: 'blocked', attempts: number} | {status: 'failed', attempts: number}>} Run status and the number of promotions attempted.
 */
export async function drainPromotionOverflow({
    maxConsecutiveFailures = Infinity,
    notify,
    gate,
    dispatch,
}) {
    const s = getEffectiveSettings();
    let failures = 0;
    let attempts = 0;
    for (;;) {
        const plan = await buildPromotionPlan(getChatStore(), s);
        if (!plan.candidate || plan.retentionFloorViolated) {
            return { status: 'completed', attempts };
        }
        if ((await gate.promptWorkGate('promotion drain')) === 'blocked') {
            return { status: 'blocked', attempts };
        }
        const promoted = await attemptPromotion(plan, s, { notify, gate, dispatch });
        attempts++;
        if ((await gate.promptWorkGate('promotion drain')) === 'blocked') {
            return { status: 'blocked', attempts };
        }
        if (promoted) {
            failures = 0;
            continue;
        }
        failures++;
        if (failures >= maxConsecutiveFailures) {
            return { status: 'failed', attempts };
        }
    }
}
