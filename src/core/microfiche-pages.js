// Microfiche page source: the one page-owning module. Consumers bind the plan,
// then read page N by index; the Raw Seal, the per-page cache, its per-epoch
// clear, and canvas capture stay behind this seam.

import { fetchTextAsset } from '../foundation/context.js';
import { MEMORY_MODES } from '../foundation/constants.js';
import { drawMicrofichePage } from './microfiche-render.js';
import { installMicroficheFonts } from './microfiche-font-cache.js';
import { MICROFICHE_FONT_FILES, parseMicroficheFont } from './microfiche-fonts.js';
import { buildMicroficheRawSlice } from './microfiche-raw-slice.js';
import { resolveMicroficheRegion } from './microfiche-transport.js';

// Geometry keys only: a key change always means new pixels. Billing or
// provider hints never land here.
const SHAPE_HASH_KEYS = [
    'font',
    'cellWidth',
    'cellHeight',
    'stretch',
    'variant',
    'stopwordDim',
    'columns',
    'lineRepeat',
    'frameSize',
];

/**
 * @typedef {object} MicrofichePage
 * @property {string} dataUrl - PNG data URL for the rendered page.
 * @property {string} text - Page text for the marker-expansion path.
 */

/**
 * @typedef {object} MicrofichePageSourceInput
 * @property {import('./microfiche-policy.js').MicrofichePlan | null} plan - Memory plan owning its page list and render shape.
 * @property {import('./microfiche-policy.js').MicroficheRawPlan | null} [rawPlan] - Frozen raw-chat plan owning its own page list and index namespace.
 * @property {number} epoch - Mutation Epoch the sealed pages belong to.
 */

/**
 * @typedef {object} MicroficheSealedPlans
 * @property {import('./microfiche-policy.js').MicrofichePlan | null} microfiche - Sealed memory plan.
 * @property {import('./microfiche-policy.js').MicroficheRawPlan | null} microficheRaw - Sealed frozen raw-chat plan.
 */

/**
 * @typedef {object} MicroficheRawSealInput
 * @property {ChatMessage[]} chat - Live chat array carrying the candidate span.
 * @property {SummaryceptionStore} store - Store owning the summarized boundary and mutation epoch.
 * @property {object | null} settings - Settings carrying the frozen-raw toggle and budgets.
 * @property {number} epoch - Mutation Epoch being sealed.
 */

/**
 * @typedef {object} MicroficheRawSeal
 * @property {number} epoch - Epoch this slice was sealed for.
 * @property {string[]} texts - Oldest-first raw slice.
 * @property {number} chatLength - Chat length the slice sealed.
 */

/**
 * @typedef {object} MicrofichePageSource
 * @property {(input: MicrofichePageSourceInput) => MicroficheSealedPlans} update - Seal both region plans for the epoch, then warm every sealed page.
 * @property {(input: MicroficheRawSealInput) => string[] | null} sealRaw - Seal or reuse the Raw Seal slice for the epoch; null when the region is off.
 * @property {(pageIndex: number, region?: 'memory' | 'raw') => MicrofichePage | undefined} readPage - Read one page by region and index.
 * @property {() => MicroficheSealedPlans | null} getSealedPlans - Read the plans the last update sealed, or null before the first update.
 * @property {() => number} size - Cached page count.
 * @property {() => void} reset - Drop the sealed plans, every cached page, and the Raw Seal, for a chat switch where the epoch can repeat.
 */

/**
 * Page source the Memory Injection writer built. The composition root builds
 * one writer per tab and that writer binds once at construction, so this is
 * entry-owned wiring (same class as `viewerDeps`): UI billing and the engine
 * trigger read the seal through it instead of rebuilding a raw slice. Tests
 * construct a writer per case and rebind per case.
 * @type {MicrofichePageSource | null}
 */
let writerPageSource = null;

/**
 * Register the writer's page source so readers can reach the sealed plans.
 * Entry construction calls this once per writer; tests once per writer built.
 * @param {MicrofichePageSource} source - Page source owned by the writer.
 * @returns {void}
 */
export function bindWriterMicrofichePageSource(source) {
    writerPageSource = source;
}

/**
 * Read the plans the writer sealed for its current epoch. A null result means
 * the writer has not sealed once yet, so no pages ship to bill or trigger on.
 * @returns {MicroficheSealedPlans | null} Sealed plans, or null before the first update.
 */
export function readSealedMicrofichePlans() {
    return writerPageSource?.getSealedPlans() ?? null;
}

/**
 * Pick the sealed regions the toggles enable. Billing and marker placement
 * share this so both ship the same regions for one settings read.
 * @param {MicroficheSealedPlans | null} sealed - Writer-sealed plans, if any.
 * @param {{ microficheMemoryImages?: unknown, microficheFrozenRawImages?: unknown } | null | undefined} settings - Effective settings carrying the region toggles.
 * @returns {{ microfiche: import('./microfiche-policy.js').MicrofichePlan | null, microficheRaw: import('./microfiche-policy.js').MicroficheRawPlan | null }} Enabled sealed regions, null when unsealed or toggled off.
 */
export function selectSealedRegions(sealed, settings) {
    if (sealed === null || sealed === undefined) {
        return { microfiche: null, microficheRaw: null };
    }
    return {
        microfiche: settings?.microficheMemoryImages === true ? sealed.microfiche : null,
        microficheRaw: settings?.microficheFrozenRawImages === true ? sealed.microficheRaw : null,
    };
}

/**
 * Canonical string over geometry keys only, so equal reading geometry
 * hashes equal even when billing extras ride along.
 * @param {import('./microfiche-geometry.js').MicroficheShape & Record<string, unknown>} shape - Render shape.
 * @returns {string} Canonical key string.
 */
export function hashMicroficheShape(shape) {
    return SHAPE_HASH_KEYS.map((key) => `${key}=${String(shape?.[key])}`).join('|');
}
/**
 * @param {import('./microfiche-policy.js').MicroficheRegionPlan | null | undefined} plan - Region plan, if any.
 * @returns {string} Geometry hash, or an empty string without a plan.
 */
function hashRegionShape(plan) {
    return plan === null || plan === undefined ? '' : hashMicroficheShape(plan.shape);
}

/**
 * @template {import('./microfiche-policy.js').MicroficheRegionPlan} T
 * @param {T | null | undefined} plan - Region plan to copy; the copy owns its page list.
 * @returns {T | null} Copy, or null.
 */
function sealPlan(plan) {
    if (plan === null || plan === undefined) {
        return null;
    }
    return {
        ...plan,
        imageTexts: Array.isArray(plan.imageTexts) ? [...plan.imageTexts] : [],
    };
}

// Bundled font URLs follow the installed extension folder because each one
// resolves from this module's own location.
const FONT_ASSET_URLS = Object.freeze(
    Object.fromEntries(
        Object.entries(MICROFICHE_FONT_FILES).map(([name, file]) => [
            name,
            new URL(`../../fonts/${file}`, import.meta.url).href,
        ]),
    ),
);

/**
 * Fetch and parse every bundled bitmap font, then install the set for the
 * synchronous draw and normalize paths. Entry init awaits this once before it
 * builds the Microfiche page source.
 * @returns {Promise<void>}
 */
export async function loadMicroficheFonts() {
    const entries = await Promise.all(
        Object.entries(FONT_ASSET_URLS).map(async ([name, url]) => {
            const text = await fetchTextAsset(url);
            return /** @type {[string, import('./microfiche-fonts.js').MicroficheFont]} */ ([
                name,
                parseMicroficheFont(name, text),
            ]);
        }),
    );
    installMicroficheFonts(Object.fromEntries(entries));
}

/**
 * Render ordered page strings into transport pages. The draw runs on one
 * injected canvas per page, and toDataURL runs on that same canvas, so the
 * image matches the laid-out text. Input order in, page order out.
 * @param {string[]} imageTexts - Page strings in chronological order.
 * @param {import('./microfiche-geometry.js').MicroficheShape} shape - Render shape.
 * @param {(width: number, height: number) => { canvas: { width: number, height: number, toDataURL: (mime?: string) => string }, ctx: { fillStyle: string, fillRect: (x: number, y: number, w: number, h: number) => void } }} canvasFactory - Injected canvas source.
 * @returns {MicrofichePage[]} Pages in input order.
 */
export function renderMicrofichePages(imageTexts, shape, canvasFactory) {
    const texts = Array.isArray(imageTexts) ? imageTexts : [];
    return texts.map((text) => {
        /** @type {{ canvas: { toDataURL: (mime?: string) => string }, ctx: object } | undefined} */
        let drawn;
        const captureFactory = (width, height) => {
            const made = canvasFactory(width, height);
            drawn = made;
            return made;
        };
        drawMicrofichePage(String(text), shape, captureFactory);
        const dataUrl =
            drawn && typeof drawn.canvas.toDataURL === 'function'
                ? drawn.canvas.toDataURL('image/png')
                : 'data:image/png;base64,';
        return { dataUrl, text: String(text) };
    });
}

/**
 * Build the one page source: readers bind a plan with update, then ask for a
 * page index. The cache is tab memory only. Epoch and geometry drift clear it,
 * and a chat switch calls reset because each chat's mutation epoch starts at
 * zero and can repeat the epoch this chat sealed.
 * @param {{
 *   canvasFactory?: ((width: number, height: number) => { canvas: { width: number, height: number, toDataURL: (mime?: string) => string }, ctx: { fillStyle: string, fillRect: (x: number, y: number, w: number, h: number) => void } }) | null,
 *   renderPage?: ((text: string, shape: import('./microfiche-geometry.js').MicroficheShape) => MicrofichePage) | null,
 * }} [deps] - Injected canvas source or per-page renderer.
 * @returns {MicrofichePageSource} Page source.
 */
export function createMicrofichePageSource({ canvasFactory = null, renderPage = null } = {}) {
    const renderer =
        typeof renderPage === 'function'
            ? renderPage
            : canvasFactory !== null && canvasFactory !== undefined
              ? (text, shape) => renderMicrofichePages([text], shape, canvasFactory)[0]
              : null;
    /** @type {{ epoch: number, shapeHash: string, plans: { memory: import('./microfiche-policy.js').MicrofichePlan | null, raw: import('./microfiche-policy.js').MicroficheRawPlan | null } } | null} */
    let sealed = null;
    /** @type {Map<string, MicrofichePage>} */
    const pages = new Map();
    const rawSeal = createRawSealSource(clearSealedPlans);

    /**
     * Seal both region plans on the first update of an epoch or a geometry
     * change. Raw-chat growth does not bump the epoch, so a later update inside
     * the same epoch reuses the sealed page lists and their pixels; the raw
     * list is the Raw Seal (ADR-0040). Memory and raw indexes stay in their own
     * lists, so the same number names a different page per region (ADR-0045).
     * @param {MicrofichePageSourceInput} input - Plans and epoch.
     * @returns {MicroficheSealedPlans} The plans this call sealed or reused.
     */
    function update({ plan, rawPlan = null, epoch }) {
        const shapeHash = `${hashRegionShape(plan)}|${hashRegionShape(rawPlan)}`;
        if (sealed === null || sealed.epoch !== epoch || sealed.shapeHash !== shapeHash) {
            pages.clear();
            sealed = {
                epoch,
                shapeHash,
                plans: { memory: sealPlan(plan), raw: sealPlan(rawPlan) },
            };
        }
        warmPages(sealed.plans.memory, 'memory');
        warmPages(sealed.plans.raw, 'raw');
        return { microfiche: sealed.plans.memory, microficheRaw: sealed.plans.raw };
    }

    /**
     * @param {import('./microfiche-policy.js').MicroficheRegionPlan | null | undefined} plan - Sealed region plan, if any.
     * @param {'memory' | 'raw'} region - Page region to warm.
     * @returns {void}
     */
    function warmPages(plan, region) {
        const imageTexts = plan?.imageTexts;
        const pageCount = Array.isArray(imageTexts) ? imageTexts.length : 0;
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
            readPage(pageIndex, region);
        }
    }

    /**
     * @param {number} pageIndex - Page index within the sealed region plan.
     * @param {'memory' | 'raw'} [region] - Page region; memory by default.
     * @returns {MicrofichePage | undefined} Cached page or undefined.
     */
    function readPage(pageIndex, region = 'memory') {
        if (sealed === null || renderer === null) {
            return undefined;
        }
        const spec = resolveMicroficheRegion(region);
        const plan = sealed.plans[spec.key];
        if (plan === null || plan === undefined || !Array.isArray(plan.imageTexts)) {
            return undefined;
        }
        if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
            return undefined;
        }
        // The sealed page list is the cap: a reader never slices it itself.
        if (pageIndex >= plan.imageTexts.length) {
            return undefined;
        }
        const cacheKey = `${spec.key}:${pageIndex}`;
        const hit = pages.get(cacheKey);
        if (hit !== undefined) {
            return hit;
        }
        const page = renderer(plan.imageTexts[pageIndex], plan.shape);
        pages.set(cacheKey, page);
        return page;
    }

    /**
     * @returns {MicroficheSealedPlans | null}
     */
    function getSealedPlans() {
        if (sealed === null) {
            return null;
        }
        return { microfiche: sealed.plans.memory, microficheRaw: sealed.plans.raw };
    }

    /**
     * @returns {number}
     */
    function size() {
        return pages.size;
    }

    /**
     * Drop the sealed plans and every cached page. A chat switch calls this
     * because the next chat's epoch can equal the sealed one, so epoch
     * equality alone cannot prove the pixels belong to the loaded chat.
     * @returns {void}
     */
    function reset() {
        clearSealedPlans();
        rawSeal.reset();
    }

    /**
     * @returns {void}
     */
    function clearSealedPlans() {
        sealed = null;
        pages.clear();
    }

    return { update, sealRaw: rawSeal.sealRaw, readPage, getSealedPlans, size, reset };
}

/**
 * Build the Raw Seal state machine. It owns the sealed slice and its epoch, so
 * the page source only asks for the slice and drops pixels when a memory-less
 * chat re-seals inside the same epoch.
 * @param {() => void} clearPages - Drops the sealed plans and their cached pixels.
 * @returns {{ sealRaw: (input: MicroficheRawSealInput) => string[] | null, reset: () => void }} Seal source.
 */
function createRawSealSource(clearPages) {
    /** @type {MicroficheRawSeal | null} */
    let seal = null;

    /**
     * Seal the Raw Seal slice for the epoch, or reuse the current seal verbatim
     * (ADR-0040). A memory-less chat follows growth: a same-epoch rebuild drops
     * the sealed plans and pixels so the next update renders the new slice.
     * @param {MicroficheRawSealInput} input - Chat, store, settings, and epoch.
     * @returns {string[] | null} Oldest-first raw slice, or null when the region is off.
     */
    function sealRaw({ chat, store, settings, epoch }) {
        if (!isFrozenRawEnabled(settings)) {
            return null;
        }
        const chatLength = Array.isArray(chat) ? chat.length : 0;
        const memoryless = !hasStoredMemory(store);
        if (needsRawReseal(seal, epoch, memoryless, chatLength)) {
            rebuild({ chat, store, settings, epoch, chatLength, memoryless });
        }
        return seal?.texts ?? null;
    }

    /**
     * @param {MicroficheRawSealInput & { chatLength: number, memoryless: boolean }} input - Rebuild inputs.
     * @returns {void}
     */
    function rebuild({ chat, store, settings, epoch, chatLength, memoryless }) {
        const epochDrift = seal === null || seal.epoch !== epoch;
        const texts = buildMicroficheRawSlice(chat, store, settings);
        if (!shouldReplaceRawSeal(epochDrift, texts, seal)) {
            return;
        }
        if (!epochDrift && memoryless) {
            clearPages();
        }
        seal = { epoch, texts, chatLength };
    }

    /**
     * @returns {void}
     */
    function reset() {
        seal = null;
    }

    return { sealRaw, reset };
}

/**
 * @param {object | null} settings - Settings carrying the frozen-raw toggle.
 * @returns {boolean} Whether the frozen-raw region is on.
 */
function isFrozenRawEnabled(settings) {
    return Boolean(
        settings?.enabled &&
        settings.memoryMode === MEMORY_MODES.MICROFICHE &&
        settings.microficheFrozenRawImages === true,
    );
}

/**
 * @param {SummaryceptionStore} store - Store owning the memory layers.
 * @returns {boolean} Whether any layer already holds a snippet.
 */
function hasStoredMemory(store) {
    return (
        Array.isArray(store?.layers) &&
        store.layers.some((layer) => Array.isArray(layer) && layer.length > 0)
    );
}

/**
 * A seal survives an epoch unless it is empty or the chat grew while no
 * memory exists; only the first snippet gives the epoch something to freeze.
 * @param {MicroficheRawSeal | null} seal - Current seal.
 * @param {number} epoch - Mutation Epoch being sealed.
 * @param {boolean} memoryless - Whether the store holds no snippets.
 * @param {number} chatLength - Current chat length.
 * @returns {boolean} Whether to rebuild the raw slice.
 */
function needsRawReseal(seal, epoch, memoryless, chatLength) {
    if (seal === null || seal.epoch !== epoch) {
        return true;
    }
    if (!memoryless) {
        return false;
    }
    return seal.chatLength !== chatLength || seal.texts.length === 0;
}

/**
 * @param {boolean} epochDrift - Whether the epoch changed.
 * @param {string[]} texts - Freshly built raw slice.
 * @param {MicroficheRawSeal | null} seal - Current seal.
 * @returns {boolean} Whether the fresh slice replaces the current seal.
 */
function shouldReplaceRawSeal(epochDrift, texts, seal) {
    if (epochDrift) {
        return true;
    }
    if (texts.length > 0) {
        return true;
    }
    return (seal?.texts.length ?? 0) === 0;
}
