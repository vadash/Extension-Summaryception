import {
    EXTENSION_PROMPT_POSITIONS,
    EXTENSION_PROMPT_ROLES,
    MEMORY_MODES,
    MEMORY_POSITIONS,
    MEMORY_ROLES,
    MODULE_NAME,
} from '../foundation/constants.js';
import { getChat, registerMacro, setExtensionPrompt } from '../foundation/context.js';
import { getChatStore, getSummaryStoreMutationEpoch } from '../foundation/chat-store.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { debug, isDebugEnabled, warn } from '../foundation/logger.js';
import { buildInjection, renderInjectionTemplate } from '../core/memory-injection.js';
import { countTextTokens, formatTokenCount } from '../core/token-count.js';
import { createMicrofichePageSource } from '../core/microfiche-pages.js';
import { buildMicroficheRawSlice } from '../core/microfiche-raw-slice.js';
import { formatMicroficheMarker, formatMicroficheRawMarker } from '../core/microfiche-transport.js';
import { maskGuardText } from '../core/guard-mask.js';

// ─── Injection via setExtensionPrompt ────────────────────────────────

const MEMORY_MACRO_NAME = 'summaryception_memory';

/**
 * @typedef {object} MemoryInjectionWriterState
 * @property {string} lastInjectionKey - Key of the last prompt written.
 * @property {string | null} activeInjectionSnapshot - Last committed slot text.
 * @property {{ position: number, depth: number, scan: boolean, role: number } | null} activeInjectionOptions - Options committed with that text.
 * @property {boolean} memoryMacroRegistered - Whether ST accepted the macro registration.
 * @property {import('../core/microfiche-pages.js').MicrofichePageSource} pageSource - Sealed Microfiche page source.
 * @property {{ epoch: number, texts: string[] } | null} sealedRawSlice - Raw Seal for the current epoch.
 */

/**
 * Build the Memory Injection writer: one instance owns the prompt slot's
 * last-written key, its committed snapshot, and the macro registration flag.
 * The composition root constructs it once (ADR-0031); a test builds its own
 * instance instead of resetting module state. The instance also holds the
 * Microfiche page source: tab memory only, sealed per Mutation Epoch, and
 * cleared on epoch or geometry drift. A chat switch clears it explicitly
 * because each chat's epoch starts at zero and can repeat the sealed one. The
 * same instance owns the slot markers for image-backed memory and frozen
 * raw-chat pages (ADR-0042), and seals the raw-chat slice per Mutation Epoch
 * (ADR-0040).
 * @param {{ canvasFactory?: ((width: number, height: number) => { canvas: { width: number, height: number, toDataURL: (mime?: string) => string }, ctx: { fillStyle: string, font: string, textBaseline: string, fillRect: (x: number, y: number, w: number, h: number) => void, fillText: (text: string, x: number, y: number) => void } }) | null }} [deps] - Injected canvas source for Microfiche renders.
 * @returns {{
 *   update: (options?: { logMemoryStatus?: boolean }) => void,
 *   reassert: () => void,
 *   registerMacro: () => Promise<boolean>,
 *   options: (settings?: ExtensionSettings) => { position: number, depth: number, scan: boolean, role: number },
 *   resolveMicrofichePage: (pageIndex: number, region?: 'memory' | 'raw') => { dataUrl: string, text: string } | undefined,
 *   resetMicrofichePages: () => void,
 * }}
 */
export function createMemoryInjectionWriter({ canvasFactory = null } = {}) {
    /** @type {MemoryInjectionWriterState} */
    const state = {
        lastInjectionKey: '',
        activeInjectionSnapshot: null,
        activeInjectionOptions: null,
        memoryMacroRegistered: false,
        pageSource: createMicrofichePageSource({ canvasFactory }),
        sealedRawSlice: null,
    };

    return {
        update: (updateOptions) => updateMemoryInjection(state, updateOptions),
        reassert: () => reassertMemoryInjection(state),
        registerMacro: () => registerMemoryMacro(state),
        options: getMemoryInjectionOptions,
        resolveMicrofichePage: (pageIndex, region) =>
            resolveMemoryMicrofichePage(state, pageIndex, region),
        resetMicrofichePages: () => resetMemoryMicrofichePages(state),
    };
}

/**
 * @param {MemoryInjectionWriterState} state - Writer state.
 * @param {{ logMemoryStatus?: boolean }} [updateOptions] - Diagnostic logging options.
 * @returns {void}
 */
function updateMemoryInjection(state, { logMemoryStatus = false } = {}) {
    try {
        const store = getChatStore();
        const settings = getEffectiveSettings();
        const epoch = getSummaryStoreMutationEpoch(store);
        const injection = buildInjection(
            store.layers,
            settings,
            null,
            getFrozenRawSlice(state, store, settings, epoch),
        );
        const sealed = state.pageSource.update({
            plan: injection.microfiche,
            rawPlan: injection.microficheRaw,
            text: injection.text,
            epoch,
        });
        const nextInjection = buildNextInjection(settings, injection, sealed);
        const nextOptions = getMemoryInjectionOptions(settings);
        state.activeInjectionSnapshot = nextInjection;
        state.activeInjectionOptions = nextOptions;

        const nextKey = getInjectionKey(nextInjection, nextOptions);
        if (nextKey === state.lastInjectionKey) {
            return;
        }

        setExtensionPrompt(MODULE_NAME, nextInjection, nextOptions);
        state.lastInjectionKey = nextKey;

        if (logMemoryStatus) {
            queueMemoryStatusLog(nextInjection, store.layers);
        }
    } catch (e) {
        warn('memory injection update error:', e);
    }
}

/**
 * The Raw Seal: the raw-chat span is selected once per Mutation Epoch and
 * reused verbatim until the epoch bump clears it, so chat growth inside
 * one epoch ships as text (ADR-0040). Only the frozen-raw toggle reads it.
 * @param {MemoryInjectionWriterState} state - Writer state.
 * @param {SummaryceptionStore} store - Store owning the summarized boundary.
 * @param {ExtensionSettings} settings - Effective settings.
 * @param {number} epoch - Mutation Epoch being sealed.
 * @returns {string[] | null} Oldest-first raw slice, or null when the region is off.
 */
function getFrozenRawSlice(state, store, settings, epoch) {
    if (
        !settings?.enabled ||
        settings?.memoryMode !== MEMORY_MODES.MICROFICHE ||
        settings?.microficheFrozenRawImages !== true
    ) {
        return null;
    }
    if (state.sealedRawSlice === null || state.sealedRawSlice.epoch !== epoch) {
        state.sealedRawSlice = {
            epoch,
            texts: buildMicroficheRawSlice(getChat(), store, settings),
        };
    } else if (state.sealedRawSlice.texts.length === 0) {
        // An empty seal freezes nothing: the first update after the chat
        // has content may seal it. Once non-empty, the epoch owns it.
        const texts = buildMicroficheRawSlice(getChat(), store, settings);
        if (texts.length > 0) {
            state.sealedRawSlice = { epoch, texts };
        }
    }
    return state.sealedRawSlice.texts;
}

/**
 * Read one rendered Microfiche page for the transport expansion seam.
 * Memory pages are the default region; raw markers pass `'raw'`.
 * Unrendered indexes stay undefined.
 * @param {MemoryInjectionWriterState} state - Writer state.
 * @param {number} pageIndex - Page index within the sealed region plan.
 * @param {'memory' | 'raw'} [region] - Page region; memory by default.
 * @returns {import('../core/microfiche-pages.js').MicrofichePage | undefined} Rendered page or undefined.
 */
function resolveMemoryMicrofichePage(state, pageIndex, region = 'memory') {
    try {
        return state.pageSource.readPage(pageIndex, region);
    } catch (e) {
        warn('memory injection microfiche read error:', e);
        return undefined;
    }
}

/**
 * Drop the sealed Microfiche plans, their pixels, and the Raw Seal. A chat
 * switch calls this because the next chat's epoch can equal the sealed one
 * and would otherwise reuse this chat's pages and raw slice.
 * @param {MemoryInjectionWriterState} state - Writer state.
 * @returns {void}
 */
function resetMemoryMicrofichePages(state) {
    state.sealedRawSlice = null;
    state.pageSource.reset();
}

/**
 * Reapply the last committed injection snapshot without reading pending changes.
 * @param {MemoryInjectionWriterState} state - Writer state.
 * @returns {void}
 */
function reassertMemoryInjection(state) {
    try {
        const text = state.activeInjectionSnapshot ?? buildDirectInjectionText();
        const options = state.activeInjectionOptions ?? getMemoryInjectionOptions();
        state.activeInjectionSnapshot = text;
        state.activeInjectionOptions = options;

        setExtensionPrompt(MODULE_NAME, text, options);
        state.lastInjectionKey = getInjectionKey(text, options);
    } catch (e) {
        warn('memory injection reassert error:', e);
    }
}

/**
 * @param {MemoryInjectionWriterState} state - Writer state.
 * @returns {Promise<boolean>} Whether ST accepted the macro registration.
 */
async function registerMemoryMacro(state) {
    if (state.memoryMacroRegistered) {
        return true;
    }

    state.memoryMacroRegistered = await registerMacro(
        MEMORY_MACRO_NAME,
        () => buildEnabledMemoryText(),
        'Returns the current Summaryception memory block.',
    );
    return state.memoryMacroRegistered;
}

/**
 * @param {ExtensionSettings} settings - Effective settings.
 * @param {import('../core/memory-injection.js').MemoryInjection} injection - Built injection.
 * @param {import('../core/microfiche-pages.js').MicroficheSealedPlans} sealed - Sealed region plans.
 * @returns {string} Slot text with Microfiche markers applied.
 */
function buildNextInjection(settings, injection, sealed) {
    return applyMicroficheMarkers(buildDirectInjectionText(settings, injection), sealed, settings);
}

/**
 * Replace image-backed page text with send-time markers, per region. Memory
 * images own the memory region and frozen raw images own the raw region, so
 * either toggle works alone: the memory region keeps its built text when its
 * toggle is off, and the raw region appends markers even on a chat with no
 * memory. Raw page text needs no slot copy because the chat already carries
 * it; only raw image pages add markers. Both placement toggles off leaves the
 * built payload byte-identical.
 * @param {string} text - Built slot text.
 * @param {import('../core/microfiche-pages.js').MicroficheSealedPlans | null} sealed - Sealed memory and raw plans.
 * @param {ExtensionSettings} settings - Effective settings.
 * @returns {string} Slot text with markers in place of image pages.
 */
function applyMicroficheMarkers(text, sealed, settings) {
    if (!settings?.enabled) {
        return text;
    }
    const memoryPlan = settings?.microficheMemoryImages === true ? sealed?.microfiche : null;
    const rawPlan = settings?.microficheFrozenRawImages === true ? sealed?.microficheRaw : null;
    const memoryText = formatMemoryRegionText(memoryPlan);
    const rawText = formatRawRegionText(rawPlan);
    if (memoryText === null && rawText === null) {
        return text;
    }
    const result = memoryText === null ? text : renderMemoryRegion(memoryText, settings);
    return rawText === null ? result : joinRegionText(result, rawText);
}

/**
 * @param {{ imageTexts?: unknown } | null | undefined} plan - Sealed region plan.
 * @returns {unknown[]} Image page texts, empty when the plan carries none.
 */
function getRegionImageTexts(plan) {
    return Array.isArray(plan?.imageTexts) ? plan.imageTexts : [];
}

/**
 * Memory markers replace every image page and keep the plan's raw page text.
 * @param {{ imageTexts?: unknown, rawTexts?: unknown } | null | undefined} plan - Sealed memory plan.
 * @returns {string | null} Memory region text, or null when the plan has no image pages.
 */
function formatMemoryRegionText(plan) {
    const imageTexts = getRegionImageTexts(plan);
    if (imageTexts.length === 0) {
        return null;
    }
    const rawTexts = Array.isArray(plan?.rawTexts) ? plan.rawTexts : [];
    return [
        ...imageTexts.map((_page, pageIndex) => formatMicroficheMarker(pageIndex)),
        ...rawTexts,
    ].join('\n');
}

/**
 * Plan text is already masked when memory masking is on, so only the template
 * needs the mask; markers must stay byte-exact for expansion.
 * @param {string} memoryText - Memory region text, already joined.
 * @param {ExtensionSettings} settings - Effective settings.
 * @returns {string} Rendered slot text for the memory region.
 */
function renderMemoryRegion(memoryText, settings) {
    const template =
        settings.guardMask === true && settings.guardMaskMemory === true
            ? maskGuardText(String(settings.injectionTemplate || '{{summary}}'))
            : null;
    return renderInjectionTemplate(
        { memoryText },
        template === null ? settings : { injectionTemplate: template },
    );
}

/**
 * Raw page text needs no slot copy because the chat already carries it; only
 * raw image pages add markers.
 * @param {{ imageTexts?: unknown } | null | undefined} plan - Sealed raw plan.
 * @returns {string | null} Raw region markers, or null when the plan has no image pages.
 */
function formatRawRegionText(plan) {
    const imageTexts = getRegionImageTexts(plan);
    if (imageTexts.length === 0) {
        return null;
    }
    return imageTexts.map((_page, pageIndex) => formatMicroficheRawMarker(pageIndex)).join('\n');
}

/**
 * @param {string} text - Built slot text.
 * @param {string} rawText - Raw region markers.
 * @returns {string} Slot text with raw markers appended.
 */
function joinRegionText(text, rawText) {
    return text ? `${text}\n${rawText}` : rawText;
}

/**
 * @param {ExtensionSettings} [settings]
 * @returns {{ position: number, depth: number, scan: boolean, role: number }}
 */
function getMemoryInjectionOptions(settings = getEffectiveSettings()) {
    if (settings.customMemoryPosition === MEMORY_POSITIONS.MACRO_ONLY) {
        return {
            position: EXTENSION_PROMPT_POSITIONS.NONE,
            depth: 0,
            scan: false,
            role: EXTENSION_PROMPT_ROLES.SYSTEM,
        };
    }

    return {
        position: mapMemoryPosition(settings.customMemoryPosition),
        depth:
            settings.customMemoryPosition === MEMORY_POSITIONS.IN_CHAT
                ? settings.customMemoryDepth
                : 0,
        scan: false,
        role: mapMemoryRole(settings.customMemoryRole),
    };
}
/**
 * Macro-only placement serves memory through the macro, so this builds
 * text only for standard placements.
 * @param {ExtensionSettings} [settings]
 * @param {{ text: string } | null} [injection] - Already-built injection, if the caller has one.
 * @returns {string}
 */
function buildDirectInjectionText(settings = getEffectiveSettings(), injection = null) {
    if (!settings.enabled || settings.customMemoryPosition === MEMORY_POSITIONS.MACRO_ONLY) {
        return '';
    }
    return buildEnabledMemoryText(settings, injection);
}

/**
 * @param {ExtensionSettings} [settings]
 * @param {{ text: string } | null} [injection] - Already-built injection, if the caller has one.
 * @returns {string}
 */
function buildEnabledMemoryText(settings = getEffectiveSettings(), injection = null) {
    if (!settings.enabled) {
        return '';
    }
    if (injection !== null) {
        return injection.text;
    }
    return buildInjection(getChatStore().layers, settings).text;
}

function mapMemoryPosition(position) {
    if (position === MEMORY_POSITIONS.BEFORE_PROMPT) {
        return EXTENSION_PROMPT_POSITIONS.BEFORE_PROMPT;
    }
    if (position === MEMORY_POSITIONS.IN_CHAT) {
        return EXTENSION_PROMPT_POSITIONS.IN_CHAT;
    }
    return EXTENSION_PROMPT_POSITIONS.IN_PROMPT;
}

function mapMemoryRole(role) {
    if (role === MEMORY_ROLES.USER) {
        return EXTENSION_PROMPT_ROLES.USER;
    }
    if (role === MEMORY_ROLES.ASSISTANT) {
        return EXTENSION_PROMPT_ROLES.ASSISTANT;
    }
    return EXTENSION_PROMPT_ROLES.SYSTEM;
}

function getInjectionKey(text, options) {
    return JSON.stringify({ text, options });
}

/**
 * Queue a best-effort memory diagnostic without delaying prompt updates.
 * @param {string} text - Injection text
 * @param {unknown[]} layers - Summary memory layers
 * @returns {void}
 */
function queueMemoryStatusLog(text, layers) {
    if (!isDebugEnabled()) {
        return;
    }
    void logMemoryStatus(text, layers);
}

/**
 * @param {string} text - Injection text
 * @param {unknown[]} layers - Summary memory layers
 * @returns {Promise<void>}
 */
async function logMemoryStatus(text, layers) {
    try {
        const tokenCount = await countTextTokens(text);
        debug(
            `Memory updated: inject ${formatTokenCount(tokenCount)} tokens; ${formatLayerCounts(layers)}`,
        );
    } catch (e) {
        debug(`Memory updated: inject ? tokens; ${formatLayerCounts(layers)}`, e);
    }
}

function formatLayerCounts(layers) {
    if (!Array.isArray(layers) || layers.length === 0) {
        return 'layers L0=0';
    }

    const highestLayer = getHighestLayerIndex(layers);
    const parts = [];
    for (let i = 0; i <= highestLayer; i++) {
        const layer = layers[i];
        parts.push(`L${i}=${Array.isArray(layer) ? layer.length : 0}`);
    }
    return `layers ${parts.join(' ')}`;
}

function getHighestLayerIndex(layers) {
    for (let i = layers.length - 1; i >= 0; i--) {
        if (Array.isArray(layers[i]) && layers[i].length > 0) {
            return i;
        }
    }
    return 0;
}
