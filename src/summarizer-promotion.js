import { getSettings, getChatStore } from './state.js';
import { log } from './logger.js';
import { buildFullContext } from './chatutils.js';
import { callSummarizer } from './summarizer-request.js';

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
        await seedNextLayer({ layer, destLayer, layerIndex, s });
        return;
    }

    await mergeLayerSnippets({ layer, destLayer, layerIndex, s });
}

/**
 * Seed a new destination layer without an LLM call.
 * @param {object} p
 * @param {Array<Record<string, unknown>>} p.layer
 * @param {Array<Record<string, unknown>>} p.destLayer
 * @param {number} p.layerIndex
 * @param {object} p.s
 * @returns {Promise<void>}
 */
async function seedNextLayer({ layer, destLayer, layerIndex, s }) {
    const seed = layer.shift();
    if (seed) {
        seed.promoted = true;
        seed.seedFromLayer = layerIndex;
        destLayer.push(seed);
    }

    log(
        `Seeded Layer ${layerIndex + 1} with oldest snippet from Layer ${layerIndex} (no LLM call)`,
    );

    toastr.info(
        `Seeded Layer ${layerIndex + 1} from Layer ${layerIndex} (free promotion)`,
        'Summaryception',
        { timeOut: 2000 },
    );

    await promoteOverflowLayers({ layer, destLayer, layerIndex, s });
}

/**
 * Merge snippets into the next layer using the summarizer.
 * @param {object} p
 * @param {Array<Record<string, unknown>>} p.layer
 * @param {Array<Record<string, unknown>>} p.destLayer
 * @param {number} p.layerIndex
 * @param {object} p.s
 * @returns {Promise<void>}
 */
async function mergeLayerSnippets({ layer, destLayer, layerIndex, s }) {
    const toMerge = layer.splice(0, s.snippetsPerPromotion);
    const storyTxt = toMerge.map((sn) => sn.text).join(' ');
    const contextStr = buildFullContext(layerIndex + 1);

    toastr.info(
        `Promoting ${toMerge.length} snippets: Layer ${layerIndex} → Layer ${layerIndex + 1}`,
        'Summaryception',
        { timeOut: 3000, progressBar: true },
    );

    const metaSummary = await callSummarizer(storyTxt, contextStr);
    if (!metaSummary) {
        layer.unshift(...toMerge);
        return;
    }

    destLayer.push({
        text: metaSummary,
        fromLayer: layerIndex,
        mergedCount: toMerge.length,
        timestamp: Date.now(),
    });

    log(`Layer ${layerIndex + 1} now has ${destLayer.length} snippets`);

    await promoteOverflowLayers({ layer, destLayer, layerIndex, s });
}

/**
 * Continue promotion while source or destination layers remain over their limits.
 * @param {object} p
 * @param {Array<Record<string, unknown>>} p.layer
 * @param {Array<Record<string, unknown>>} p.destLayer
 * @param {number} p.layerIndex
 * @param {object} p.s
 * @returns {Promise<void>}
 */
async function promoteOverflowLayers({ layer, destLayer, layerIndex, s }) {
    if (layer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex);
    }
    if (destLayer.length > s.snippetsPerLayer) {
        await maybePromoteLayer(layerIndex + 1);
    }
}
