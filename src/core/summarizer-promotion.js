import { getSettings, getChatStore, saveChatStore } from '../foundation/state.js';
import { log } from '../foundation/logger.js';
import { buildFullContext } from './chatutils.js';
import { callSummarizer } from './summarizer-request.js';
import {
    commitWhenSafe,
    isPromptMutationFrozen,
    updateCommittedInjection,
} from './summarizer-commit.js';
import {
    fingerprintSummaryStore,
    getChatIdentity,
    isSameChatSnapshot,
} from './summarizer-snapshot.js';

/**
 * Promote a layer's snippets to the next layer if over the limit.
 * @param {number} layerIndex - The layer to evaluate
 * @returns {Promise<void>}
 */
export async function maybePromoteLayer(layerIndex) {
    const s = getSettings();
    const store = getChatStore();

    if (layerIndex >= s.maxLayers - 1) {
        log(`Max layer depth (${s.maxLayers}) reached.`);
        return;
    }

    const layer = store.layers[layerIndex];
    if (!layer || layer.length <= s.snippetsPerLayer) {
        return;
    }

    log(`Layer ${layerIndex}: ${layer.length} snippets > limit ${s.snippetsPerLayer} → promoting`);

    if (!store.layers[layerIndex + 1]) {
        store.layers[layerIndex + 1] = [];
    }
    const destLayer = store.layers[layerIndex + 1];

    if (destLayer.length === 0) {
        await seedNextLayer({ layerIndex, s });
        return;
    }

    await mergeLayerSnippets({ layerIndex, s });
}

/**
 * Seed a new destination layer without an LLM call.
 * @param {object} p
 * @param {number} p.layerIndex
 * @param {object} p.s
 * @returns {Promise<void>}
 */
async function seedNextLayer({ layerIndex, s }) {
    const snapshot = capturePromotionSnapshot(layerIndex);
    const result = await commitWhenSafe({
        kind: 'promotion-seed',
        snapshot,
        apply: async () => applySeedPromotion({ snapshot, layerIndex }),
    });

    if (result === 'applied') {
        await promoteOverflowLayers({ layerIndex, s });
    }
}

/**
 * Merge snippets into the next layer using the summarizer.
 * @param {object} p
 * @param {number} p.layerIndex
 * @param {object} p.s
 * @returns {Promise<void>}
 */
async function mergeLayerSnippets({ layerIndex, s }) {
    const store = getChatStore();
    const layer = store.layers[layerIndex] || [];
    const toMerge = layer.slice(0, s.snippetsPerPromotion);
    const storyTxt = toMerge.map((sn) => sn.text).join(' ');
    const contextStr = buildFullContext(layerIndex + 1);
    const snapshot = {
        ...capturePromotionSnapshot(layerIndex),
        mergeCount: toMerge.length,
        storyTxt,
        contextStr,
    };

    toastr.info(
        `Promoting ${toMerge.length} snippets: Layer ${layerIndex} → Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: 3000, progressBar: true },
    );

    const metaSummary = await callSummarizer(storyTxt, contextStr);
    if (!metaSummary) {
        return;
    }

    const result = await commitWhenSafe({
        kind: 'promotion-merge',
        snapshot,
        apply: async () =>
            applyMergePromotion({
                snapshot,
                layerIndex,
                metaSummary,
            }),
    });

    if (result === 'applied') {
        await promoteOverflowLayers({ layerIndex, s });
    }
}

/**
 * Capture summary-store state for a promotion transaction.
 * @param {number} layerIndex
 * @returns {object}
 */
function capturePromotionSnapshot(layerIndex) {
    const ctx = SillyTavern.getContext();
    const store = getChatStore();

    return {
        chatId: getChatIdentity(ctx),
        chatRef: ctx.chat,
        layerIndex,
        summaryStoreFingerprint: fingerprintSummaryStore(store),
    };
}

/**
 * Apply a no-LLM seed promotion after validating the source layers.
 * @param {object} p
 * @param {object} p.snapshot
 * @param {number} p.layerIndex
 * @returns {Promise<boolean>}
 */
async function applySeedPromotion({ snapshot, layerIndex }) {
    if (!isPromotionSnapshotValid(snapshot)) {
        return false;
    }

    const store = getChatStore();
    const layer = store.layers[layerIndex] || [];
    const destLayer = store.layers[layerIndex + 1] || [];
    const seed = layer.shift();

    if (!seed) {
        return false;
    }

    seed.promoted = true;
    seed.seedFromLayer = layerIndex;
    destLayer.push(seed);
    store.layers[layerIndex + 1] = destLayer;

    await savePromotionCommit();

    log(
        `Seeded Layer ${layerIndex + 1} with oldest snippet from Layer ${layerIndex} (no LLM call)`,
    );

    toastr.info(
        `Seeded Layer ${layerIndex + 1} from Layer ${layerIndex} (free promotion)`,
        'Summaryception',
        { timeOut: 2000 },
    );

    return true;
}

/**
 * Apply an LLM-backed merge promotion after validating the source layers.
 * @param {object} p
 * @param {object} p.snapshot
 * @param {number} p.layerIndex
 * @param {string} p.metaSummary
 * @returns {Promise<boolean>}
 */
async function applyMergePromotion({ snapshot, layerIndex, metaSummary }) {
    if (!isPromotionSnapshotValid(snapshot)) {
        return false;
    }

    const store = getChatStore();
    const layer = store.layers[layerIndex] || [];
    const destLayer = store.layers[layerIndex + 1] || [];
    const toMerge = layer.splice(0, snapshot.mergeCount);

    if (toMerge.length !== snapshot.mergeCount) {
        return false;
    }

    destLayer.push({
        text: metaSummary,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
    });
    store.layers[layerIndex + 1] = destLayer;

    await savePromotionCommit();
    log(`Layer ${layerIndex + 1} now has ${destLayer.length} snippets`);

    return true;
}

/**
 * Revalidate that summary layers were not changed during a promotion request.
 * @param {object} snapshot
 * @returns {boolean}
 */
function isPromotionSnapshotValid(snapshot) {
    const ctx = SillyTavern.getContext();
    const store = getChatStore();

    if (!isSameChatSnapshot(snapshot, ctx)) {
        return false;
    }
    return fingerprintSummaryStore(store) === snapshot.summaryStoreFingerprint;
}

/**
 * Persist a promotion and refresh injection when the foreground guard permits it.
 * @returns {Promise<void>}
 */
async function savePromotionCommit() {
    await saveChatStore();
    if (!isPromptMutationFrozen()) {
        updateCommittedInjection();
    }
}

/**
 * Continue promotion while source or destination layers remain over their limits.
 * @param {object} p
 * @param {number} p.layerIndex
 * @param {object} p.s
 * @returns {Promise<void>}
 */
async function promoteOverflowLayers({ layerIndex, s }) {
    if (isPromptMutationFrozen()) {
        return;
    }

    const store = getChatStore();
    const layer = store.layers[layerIndex] || [];
    const destLayer = store.layers[layerIndex + 1] || [];

    if (layer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex);
    }
    if (destLayer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex + 1);
    }
}
