/**
 * Dry-Run Preview: capture the host's dry-run chat completion, expand the
 * Microfiche markers on a clone, run the shared outgoing rewrite on that
 * clone, and render the read-only prompt viewer (ADR-0041, ADR-0043).
 * The live payload never mutates here; the one-shot listener reads
 * `eventData.chat`, snapshots capture-time facts at arrival, clones it, and
 * the prod `onChatCompletionPromptReady` dry-run early return stays untouched.
 */

import { MEMORY_MODES, TOAST_TITLE } from '../foundation/constants.js';
import {
    getChat,
    getEventSource,
    getEventTypes,
    getMainApi,
    getPopupApi,
    getPromptManager,
    runDryRunGenerate,
} from '../foundation/context.js';
import { getChatStore, getSummaryStoreMutationEpoch } from '../foundation/chat-store.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { refreshInjection } from '../foundation/refresh.js';
import { debug, warn } from '../foundation/logger.js';
import {
    expandMicrofichePromptChat,
    extractMicroficheMarkers,
    resolveMicroficheRegion,
} from '../core/microfiche-transport.js';
import { buildInjection } from '../core/memory-injection.js';
import { rewriteOutgoingPrompt } from '../core/outgoing-rewrite.js';
import {
    buildOutgoingContext,
    captureOutgoingSnapshot,
    deriveOutgoingDivergence,
} from './outgoing-context.js';
import { createMicrofichePageSource } from '../core/microfiche-pages.js';

/** Guard against a host dry run that never emits its prompt-ready event. */
const CAPTURE_TIMEOUT_MS = 15000;

const CHAT_COMPLETION_API = 'openai';

/**
 * @typedef {object} MicrofichePageRef
 * @property {string} dataUrl - Rendered page data URL.
 * @property {string} text - Page text the marker was standing in for.
 */

/**
 * @typedef {object} ExpandedChat
 * @property {unknown[]} chat - Cloned chat with markers swapped for parts.
 * @property {number} resolvedMarkers - Marker swaps performed on the clone.
 * @property {(number | string)[]} unresolvedMarkers - Page labels whose markers survived.
 */

/**
 * @typedef {object} DryRunPromptView
 * @property {unknown[]} chat - Expanded clone with the shared outgoing rewrite applied; the clipboard payload.
 * @property {number} epoch - Mutation Epoch the captured memory was sealed for.
 * @property {{ memoryImages: boolean, frozenRawImages: boolean }} toggles - Image region toggles.
 * @property {number} payloadBytes - Serialized size of the captured chat.
 * @property {number} imageParts - Image parts present in the expanded clone.
 * @property {number} resolvedMarkers - Marker swaps performed on the clone.
 * @property {(number | string)[]} unresolvedMarkers - Page labels whose markers survived.
 * @property {Array<{ kind: string, count?: number }>} divergences - Known dry-run assembly differences plus capture-time changes.
 * @property {{ slotStatus: string, staleReason: string | null }} outgoing - Shared rewrite result for the preview clone.
 */

/**
 * @typedef {object} DryRunViewerDeps
 * @property {import('../core/foreground-gate.js').ForegroundGate} gate - Refuses the capture while frozen.
 * @property {import('../core/summarizer-queue.js').SummarizerQueue} queue - Refuses the capture while work is live.
 * @property {(pageIndex: number, region?: import('../core/microfiche-transport.js').MicroficheRegion) => MicrofichePageRef | undefined} [resolveMicrofichePage] - Page reader; the composition root passes `writer.resolveMicrofichePage`.
 * @property {import('./outgoing-context.js').OutgoingContextWriter | null} [writer] - Shared Memory Injection writer.
 * @property {() => unknown} [warmPages] - Warms the writer's sealed pages before capture; defaults to the gated injection refresh.
 * @property {() => Promise<unknown>} [triggerDryRun] - Host dry-run generate.
 * @property {(view: DryRunPromptView) => void} [showView] - Replace the host popup, for tests.
 * @property {() => ExtensionSettings} [getSettings] - Effective settings read.
 */

/** @type {DryRunViewerDeps | null} */
let viewerDeps = null;

/**
 * Install the capture dependencies once at entry wiring. The Dry-Run Preview
 * has no independent trigger: both the slash command and the Status button
 * call the same capture path through this module.
 * @param {DryRunViewerDeps} deps - Gate, queue, page reader, and optional seams.
 * @returns {void}
 */
export function initDryRunViewer(deps) {
    viewerDeps = { warmPages: () => refreshInjection(), ...deps };
}

/**
 * Fallback page reader for callers without writer access (tests and headless
 * wiring). It binds the same page source seam as the writer: the source seals
 * the Raw Seal and renders each plan once, then every read returns that sealed
 * state, so the pixels match the writer's for this Mutation Epoch. The
 * composition root normally injects `writer.resolveMicrofichePage` instead.
 * @param {ExtensionSettings} settings - Effective settings.
 * @returns {(pageIndex: number, region?: import('../core/microfiche-transport.js').MicroficheRegion) => MicrofichePageRef | undefined} Page reader.
 */
export function createPlanPageReader(settings) {
    const pageSource = createMicrofichePageSource({ canvasFactory: createBrowserCanvas });
    let bound = false;
    const bindSealedPages = () => {
        if (bound) {
            return pageSource;
        }
        bound = true;
        const store = getChatStore();
        const epoch = getSummaryStoreMutationEpoch(store);
        const rawTexts = pageSource.sealRaw({ chat: getChat(), store, settings, epoch });
        const injection = buildInjection(store.layers, settings, null, { rawTexts });
        pageSource.update({
            plan: injection.microfiche,
            rawPlan: injection.microficheRaw,
            epoch,
        });
        return pageSource;
    };
    return (pageIndex, region = 'memory') => bindSealedPages().readPage(pageIndex, region);
}

/**
 * Browser canvas source for one Microfiche page render.
 * @param {number} width - Canvas width in pixels.
 * @param {number} height - Canvas height in pixels.
 * @returns {{ canvas: { width: number, height: number, toDataURL: (mime?: string) => string }, ctx: object }} Draw target.
 */
function createBrowserCanvas(width, height) {
    const canvas = /** @type {HTMLCanvasElement} */ (document.createElement('canvas'));
    canvas.width = width;
    canvas.height = height;
    return { canvas, ctx: canvas.getContext('2d') };
}

/**
 * Deep-clone the captured chat so nothing downstream can touch the host payload.
 * @param {unknown[]} chat - Captured chat array.
 * @returns {unknown[]} Independent copy.
 */
function cloneChat(chat) {
    if (typeof globalThis.structuredClone === 'function') {
        return globalThis.structuredClone(chat);
    }
    return JSON.parse(JSON.stringify(chat));
}

/**
 * Every text fragment a message's content carries, in order.
 * @param {unknown} content - Message content.
 * @returns {string[]} Text fragments.
 */
function contentTexts(content) {
    if (typeof content === 'string') {
        return [content];
    }
    if (!Array.isArray(content)) {
        return [];
    }
    const texts = [];
    for (const part of content) {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
            texts.push(part.text);
        }
    }
    return texts;
}

/**
 * Marker page labels that survived expansion, so the viewer can flag them
 * while leaving the literal marker text in place. Raw labels carry the `:raw`
 * suffix because raw page 0 and memory page 0 are different pages.
 * @param {unknown[]} chat - Expanded chat.
 * @returns {(number | string)[]} Unresolved page labels in encounter order.
 */
function collectUnresolvedMarkers(chat) {
    const found = new Set();
    /** @type {(number | string)[]} */
    const labels = [];
    for (const message of chat) {
        if (!message || typeof message !== 'object') {
            continue;
        }
        for (const text of contentTexts(/** @type {{ content?: unknown }} */ (message).content)) {
            for (const marker of extractMicroficheMarkers(text)) {
                const suffix = resolveMicroficheRegion(marker.region).suffix;
                const label = suffix ? `${marker.pageIndex}${suffix}` : marker.pageIndex;
                if (!found.has(label)) {
                    found.add(label);
                    labels.push(label);
                }
            }
        }
    }
    return labels;
}

/**
 * Clone the captured chat and expand its markers on the clone only.
 * @param {unknown[]} chat - Chat array the host dry run produced.
 * @param {(pageIndex: number, region?: import('../core/microfiche-transport.js').MicroficheRegion) => MicrofichePageRef | undefined} resolvePage - Writer page reader.
 * @returns {ExpandedChat} Expanded clone and marker bookkeeping.
 */
export function expandCapturedChat(chat, resolvePage) {
    const clone = cloneChat(chat);
    let resolvedMarkers = 0;
    try {
        resolvedMarkers = expandMicrofichePromptChat(
            /** @type {Record<string, unknown>[]} */ (clone),
            resolvePage,
        );
    } catch (e) {
        warn('Dry-Run Preview expansion failed:', e);
    }
    return { chat: clone, resolvedMarkers, unresolvedMarkers: collectUnresolvedMarkers(clone) };
}
/**
 * Run the shared outgoing rewrite on the preview clone. The host dry run
 * early-returns before GENERATE_AFTER_DATA, so the capture is pre-transform
 * by construction (ADR-0044). Clone-only; the live payload never mutates here.
 * @param {unknown[]} chat - Expanded preview clone.
 * @param {import('./outgoing-context.js').OutgoingContextWriter | null} writer - Shared writer.
 * @param {ExtensionSettings} settings - Effective settings at transform time.
 * @param {Partial<import('./outgoing-context.js').OutgoingContextOptions>} [overrides] - Fact overrides; tests stay host-free.
 * @returns {{ slotStatus: string, staleReason: string | null }} Shared rewrite result.
 */
export function applyOutgoingRewriteToPreview(chat, writer, settings, overrides = {}) {
    try {
        const context = buildOutgoingContext(/** @type {Array<Record<string, unknown>>} */ (chat), {
            writer,
            settings,
            ...overrides,
        });
        const result = rewriteOutgoingPrompt(
            /** @type {Array<Record<string, unknown>>} */ (chat),
            context,
        );
        return { slotStatus: result.slotStatus, staleReason: result.staleReason };
    } catch (e) {
        warn('Dry-Run Preview guard mask failed:', e);
        return { slotStatus: 'unresolved', staleReason: 'preview-failed' };
    }
}
/**
 * Adjacent unnamed system messages the live chat-completion path would squash.
 * SillyTavern skips `squashSystemMessages` for dry runs, so the capture shows
 * more system blocks than the model receives.
 * @param {unknown[]} chat - Expanded chat.
 * @returns {number} Count of adjacent unnamed system pairs.
 */
function countUnsquashedSystems(chat) {
    let pairs = 0;
    let previousWasSystem = false;
    for (const message of chat) {
        const entry = /** @type {{ role?: unknown, name?: unknown }} */ (message);
        const isSystem =
            entry?.role === 'system' && (entry.name === undefined || entry.name === null);
        if (isSystem && previousWasSystem) {
            pairs++;
        }
        previousWasSystem = isSystem;
    }
    return pairs;
}

/**
 * @param {unknown[]} chat - Expanded chat.
 * @returns {number} Image parts in the clone.
 */
function countImageParts(chat) {
    let images = 0;
    for (const message of chat) {
        const content = /** @type {{ content?: unknown }} */ (message)?.content;
        if (!Array.isArray(content)) {
            continue;
        }
        for (const part of content) {
            if (part && typeof part === 'object' && part.type === 'image_url') {
                images++;
            }
        }
    }
    return images;
}

/**
 * @param {unknown} value - Candidate value.
 * @returns {number} UTF-8 byte length of its JSON form.
 */
function jsonByteLength(value) {
    const text = JSON.stringify(value) ?? '';
    if (typeof TextEncoder === 'function') {
        return new TextEncoder().encode(text).length;
    }
    return text.length;
}

/**
 * Build the header and body facts the viewer renders.
 * @param {{ chat: unknown[], epoch: number, settings: ExtensionSettings, resolvedMarkers: number, unresolvedMarkers: (number | string)[], promptManagerReady: boolean, captureDivergences?: Array<{ kind: string, count?: number }>, outgoing?: { slotStatus: string, staleReason: string | null } }} input - Capture facts.
 * @returns {DryRunPromptView} View model.
 */
export function describeDryRunPrompt({
    chat,
    epoch,
    settings,
    resolvedMarkers,
    unresolvedMarkers,
    promptManagerReady,
    captureDivergences = [],
    outgoing = { slotStatus: 'absent', staleReason: null },
}) {
    const toggles = {
        memoryImages: settings?.memoryMode === MEMORY_MODES.MICROFICHE,
        frozenRawImages: Boolean(settings?.microficheFrozenRawImages),
    };
    const imageParts = countImageParts(chat);
    /** @type {Array<{ kind: string, count?: number }>} */
    const divergences = Array.isArray(captureDivergences) ? [...captureDivergences] : [];
    const unsquashed = countUnsquashedSystems(chat);
    if (unsquashed > 0) {
        divergences.push({ kind: 'unsquashed-systems', count: unsquashed });
    }
    if (!promptManagerReady) {
        divergences.push({ kind: 'pre-settings-ready' });
    }
    if (outgoing.slotStatus === 'unresolved' || outgoing.slotStatus === 'stale') {
        divergences.push({ kind: 'slot-unresolved' });
    }
    return {
        chat,
        epoch,
        toggles,
        payloadBytes: jsonByteLength(chat),
        imageParts,
        resolvedMarkers,
        unresolvedMarkers,
        divergences,
        outgoing: {
            slotStatus: outgoing.slotStatus,
            staleReason: outgoing.staleReason,
        },
    };
}

/**
 * @param {number} bytes - Byte count.
 * @returns {string} Compact size label.
 */
function formatBytes(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * @typedef {{ kind: 'text', text: string } | { kind: 'image', url: string } | { kind: 'raw', json: string }} RenderablePart
 */

/**
 * @param {unknown} content - Message content.
 * @returns {RenderablePart[]} Renderable parts.
 */
function renderableParts(content) {
    if (typeof content === 'string') {
        return [{ kind: 'text', text: content }];
    }
    if (!Array.isArray(content)) {
        return [{ kind: 'raw', json: JSON.stringify(content) ?? '' }];
    }
    /** @type {RenderablePart[]} */
    const parts = [];
    for (const part of content) {
        const entry = /** @type {Record<string, unknown>} */ (part);
        if (entry?.type === 'text' && typeof entry.text === 'string') {
            parts.push({ kind: 'text', text: entry.text });
            continue;
        }
        if (entry?.type === 'image_url') {
            const image = /** @type {{ url?: unknown }} */ (entry.image_url);
            parts.push({ kind: 'image', url: String(image?.url ?? '') });
            continue;
        }
        parts.push({ kind: 'raw', json: JSON.stringify(part) ?? '' });
    }
    return parts;
}

/**
 * Render one message block.
 * @param {unknown} message - Captured chat message.
 * @param {number} index - Index within the captured array.
 * @returns {object} jQuery element.
 */
function buildMessageBlock(message, index) {
    const entry = /** @type {{ role?: unknown, name?: unknown, content?: unknown }} */ (message);
    const role = typeof entry?.role === 'string' ? entry.role : 'unknown';
    const parts = renderableParts(entry?.content);

    const $block = $('<section class="sc-dryrun-message"></section>')
        .attr('data-sc-dryrun-message', '')
        .attr('data-sc-dryrun-index', String(index))
        .attr('data-sc-dryrun-role', role);

    const $header = $('<header class="sc-dryrun-message-header"></header>');
    $header.append($('<span class="sc-dryrun-index"></span>').text(`#${index}`));
    $header.append($('<span class="sc-dryrun-role"></span>').text(role));
    if (typeof entry?.name === 'string' && entry.name !== '') {
        $header.append($('<span class="sc-dryrun-name"></span>').text(entry.name));
    }
    const imageCount = parts.filter((part) => part.kind === 'image').length;
    $header.append(
        $('<span class="sc-dryrun-parts"></span>').text(
            `${parts.length} part${parts.length === 1 ? '' : 's'}`,
        ),
    );
    if (imageCount > 0) {
        $header.append($('<span class="sc-dryrun-chip"></span>').text(`${imageCount} image(s)`));
    }
    $block.append($header);

    const $body = $('<div class="sc-dryrun-message-body"></div>');
    let textIndex = 0;
    for (const part of parts) {
        if (part.kind === 'text') {
            $body.append(buildTextPart(part.text, textIndex++));
            continue;
        }
        if (part.kind === 'image') {
            $body.append(buildImagePart(part.url));
            continue;
        }
        $body.append(
            $('<pre class="sc-dryrun-raw" data-sc-dryrun-part="raw"></pre>').text(part.json),
        );
    }
    $block.append($body);
    return $block;
}

/**
 * @param {string} text - Text fragment.
 * @param {number} index - Text part index within the message.
 * @returns {object} jQuery `<details>` element.
 */
function buildTextPart(text, index) {
    const $part = $('<details class="sc-dryrun-text"></details>')
        .attr('data-sc-dryrun-part', 'text')
        .attr('data-sc-dryrun-text-index', String(index));
    $part.append(
        $('<summary class="sc-dryrun-text-summary"></summary>').text(`text · ${text.length} chars`),
    );
    $part.append($('<pre class="sc-dryrun-text-body"></pre>').text(text));
    return $part;
}

/**
 * @param {string} url - Image data URL.
 * @returns {object} jQuery figure wrapping the enlargeable image.
 */
function buildImagePart(url) {
    const $figure = $('<figure class="sc-dryrun-image-wrap"></figure>').attr(
        'data-sc-dryrun-part',
        'image',
    );
    $figure.append(
        $('<img class="sc-dryrun-image" data-sc-dryrun-image alt="Microfiche page"></img>').attr(
            'src',
            url,
        ),
    );
    return $figure;
}

/**
 * @param {{ kind: string, count?: number }} divergence - Structured divergence.
 * @returns {string} User-facing note.
 */
function divergenceText(divergence) {
    if (divergence.kind === 'unsquashed-systems') {
        return `${divergence.count ?? 0} adjacent system message pair(s) stay unsquashed; the dry run skips SillyTavern's system squash.`;
    }
    if (divergence.kind === 'pre-settings-ready') {
        return 'Chat-completion settings were not ready; the prompt may reflect defaults.';
    }
    if (divergence.kind === 'model-changed') {
        return 'The generation model changed since capture; the Guard verdict may differ.';
    }
    if (divergence.kind === 'chat-tail-changed') {
        return 'Chat moved since capture; the Preset CoT anchor may differ.';
    }
    if (divergence.kind === 'settings-changed') {
        return 'Settings changed since capture; the rewrite may differ.';
    }
    if (divergence.kind === 'slot-changed') {
        return 'Memory changed since capture; the slot identity may differ.';
    }
    if (divergence.kind === 'slot-unresolved') {
        return 'The Memory Slot identity is unresolved; the slot was over-masked.';
    }
    if (divergence.kind === 'capture-unavailable') {
        return 'Capture facts were unavailable; changes since capture are unknown.';
    }
    return divergence.kind;
}

/**
 * @param {DryRunPromptView} view - View model.
 * @returns {object} jQuery root element.
 */
export function buildDryRunView(view) {
    const $root = $('<div class="sc-dryrun"></div>');

    const $header = $('<div class="sc-dryrun-header"></div>');
    $header.append($('<h3 class="sc-dryrun-title"></h3>').text('Dry-Run Preview'));

    const $meta = $('<div class="sc-dryrun-meta"></div>');
    $meta.append(
        $('<span class="sc-dryrun-chip"></span>')
            .attr('data-sc-dryrun-epoch', String(view.epoch))
            .text(`Mutation Epoch ${view.epoch}`),
    );
    $meta.append(
        $('<span class="sc-dryrun-chip"></span>')
            .attr('data-sc-dryrun-toggle', 'memoryImages')
            .text(`Memory images ${view.toggles.memoryImages ? 'on' : 'off'}`),
    );
    $meta.append(
        $('<span class="sc-dryrun-chip"></span>')
            .attr('data-sc-dryrun-toggle', 'frozenRawImages')
            .text(`Frozen raw images ${view.toggles.frozenRawImages ? 'on' : 'off'}`),
    );
    $meta.append(
        $('<span class="sc-dryrun-chip"></span>')
            .attr('data-sc-dryrun-size', String(view.payloadBytes))
            .text(`Payload ${formatBytes(view.payloadBytes)}`),
    );
    $meta.append(
        $('<span class="sc-dryrun-chip"></span>')
            .attr('data-sc-dryrun-image-count', String(view.imageParts))
            .text(`${view.imageParts} image part(s)`),
    );
    $header.append($meta);

    const $flags = $('<div class="sc-dryrun-flags"></div>');
    for (const divergence of view.divergences) {
        $flags.append(
            $('<div class="sc-dryrun-note"></div>')
                .attr('data-sc-dryrun-divergence', divergence.kind)
                .text(divergenceText(divergence)),
        );
    }
    const imagesToggled = view.toggles.memoryImages || view.toggles.frozenRawImages;
    const zeroImages = imagesToggled && view.imageParts === 0;
    if (zeroImages) {
        $flags.append(
            $(
                '<div class="sc-dryrun-note sc-dryrun-note_warn" data-sc-dryrun-zero-images=""></div>',
            ).text('Image toggles are on, but the captured prompt carries no images.'),
        );
    }
    if (view.unresolvedMarkers.length > 0) {
        $flags.append(
            $(
                '<div class="sc-dryrun-note sc-dryrun-note_warn" data-sc-dryrun-unresolved=""></div>',
            ).text(`Unresolved markers left literal: page ${view.unresolvedMarkers.join(', ')}.`),
        );
    }
    if (view.divergences.length > 0 || zeroImages || view.unresolvedMarkers.length > 0) {
        $header.append($flags);
    }

    $header.append(
        $('<button type="button" class="menu_button sc-dryrun-copy"></button>')
            .attr('data-sc-dryrun-copy', '')
            .append('<i class="fa-solid fa-clipboard"></i>')
            .append($('<span></span>').text('Copy JSON')),
    );
    $root.append($header);

    const $messages = $('<div class="sc-dryrun-messages"></div>');
    view.chat.forEach((message, index) => $messages.append(buildMessageBlock(message, index)));
    $root.append($messages);

    $root.on('click', '[data-sc-dryrun-image]', function () {
        $(this).toggleClass('sc-dryrun-image_zoomed');
    });
    $root.on('click', '[data-sc-dryrun-copy]', () => {
        void copyPromptChat(view.chat);
    });
    return $root;
}

/**
 * Copy exactly the captured chat array as JSON. Header metadata never leaves
 * the screen.
 * @param {unknown[]} chat - Expanded captured chat.
 * @returns {Promise<string>} The copied JSON text.
 */
export async function copyPromptChat(chat) {
    const payload = JSON.stringify(chat);
    try {
        const clipboard = globalThis.navigator?.clipboard;
        if (typeof clipboard?.writeText === 'function') {
            await clipboard.writeText(payload);
            toastr.success('Prompt JSON copied.', TOAST_TITLE);
            return payload;
        }
    } catch (e) {
        warn('Dry-Run Preview clipboard write failed:', e);
    }
    copyWithTextarea(payload);
    return payload;
}

/**
 * Legacy clipboard fallback for browsers without the async API.
 * @param {string} payload - Text to copy.
 * @returns {void}
 */
function copyWithTextarea(payload) {
    try {
        const area = document.createElement('textarea');
        area.value = payload;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        const copied = document.execCommand('copy');
        area.remove();
        if (copied) {
            toastr.success('Prompt JSON copied.', TOAST_TITLE);
        }
    } catch (e) {
        warn('Dry-Run Preview clipboard fallback failed:', e);
    }
}

/**
 * Fire the host dry-run generate and resolve with the chat it emits. The
 * listener arms before the trigger so no prompt-ready event is missed, and it
 * detaches itself on the first event, the timeout, or a trigger failure.
 * Capture-time facts snapshot inside the event handler, so later live changes
 * surface as divergence instead of silently moving the baseline.
 * @param {{ trigger: () => Promise<unknown>, timeoutMs?: number, captureFacts?: () => import('./outgoing-context.js').OutgoingCaptureSnapshot | null }} options - Trigger, timeout, and arrival snapshot.
 * @returns {Promise<{ chat: unknown[], snapshot: import('./outgoing-context.js').OutgoingCaptureSnapshot | null } | null>} Captured chat and arrival facts, or null.
 */
export async function captureHostDryRun({ trigger, timeoutMs = CAPTURE_TIMEOUT_MS, captureFacts }) {
    const eventSource = getEventSource();
    const eventTypes = getEventTypes();
    const eventName = eventTypes?.CHAT_COMPLETION_PROMPT_READY;
    if (!eventSource || !eventName) {
        warn('Dry-Run Preview cannot listen: CHAT_COMPLETION_PROMPT_READY is unavailable.');
        return null;
    }
    return await new Promise((resolve) => {
        let settled = false;
        const detach = () => {
            if (typeof eventSource.removeListener === 'function') {
                eventSource.removeListener(eventName, handler);
                return;
            }
            eventSource.off?.(eventName, handler);
        };
        const settle = (value) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            detach();
            resolve(value);
        };
        /** @param {unknown} eventData - Prompt-ready payload. */
        const handler = (eventData) => {
            const chat = /** @type {{ chat?: unknown }} */ (eventData)?.chat;
            if (!Array.isArray(chat)) {
                settle(null);
                return;
            }
            let snapshot = null;
            try {
                snapshot = typeof captureFacts === 'function' ? captureFacts() : null;
            } catch (e) {
                warn('Dry-Run Preview capture facts failed:', e);
                snapshot = null;
            }
            settle({ chat, snapshot });
        };
        const timer = setTimeout(() => settle(null), timeoutMs);
        eventSource.on(eventName, handler);
        Promise.resolve()
            .then(trigger)
            .catch((e) => {
                warn('Dry-Run Preview generate failed:', e);
                settle(null);
            });
    });
}

/**
 * Show the read-only prompt modal through the host Popup, or the injected
 * renderer in tests.
 * @param {DryRunPromptView} view - View model.
 * @param {DryRunViewerDeps} deps - Capture deps.
 * @returns {Promise<void>}
 */
async function showDryRunView(view, deps) {
    if (typeof deps.showView === 'function') {
        deps.showView(view);
        return;
    }
    const popupApi = getPopupApi();
    if (!popupApi) {
        warn('Dry-Run Preview cannot open: host Popup is unavailable.');
        return;
    }
    const PopupCtor =
        /** @type {new (content: unknown, type: number, inputValue?: string, options?: Record<string, unknown>) => { show: () => Promise<unknown> }} */ (
            popupApi.Popup
        );
    const popup = new PopupCtor(buildDryRunView(view), popupApi.popupType.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
        okButton: 'Close',
        cancelButton: null,
    });
    await popup.show();
}

/**
 * Shared capture path behind the slash command and the Status button.
 * @returns {Promise<void>}
 */
export async function openDryRunPreview() {
    const deps = viewerDeps;
    if (!deps) {
        warn('Dry-Run Preview is not wired; skipping capture.');
        return;
    }
    if (previewBlocked(deps)) {
        return;
    }
    await warmPreviewPages(deps);
    const writer = deps.writer ?? null;
    const captured = await captureHostDryRun({
        trigger: deps.triggerDryRun ?? runDryRunGenerate,
        captureFacts: () => captureOutgoingSnapshot({ writer }),
    });
    if (!captured) {
        toastr.warning(
            'Dry run produced no prompt. Check the character and chat-completion settings.',
            TOAST_TITLE,
        );
        return;
    }
    const view = buildPreviewView(captured, deps, writer);
    debug(
        `Dry-Run Preview captured ${view.chat.length} messages, ${view.imageParts} image part(s).`,
    );
    await showDryRunView(view, deps);
}

/**
 * Gate the preview behind the host API and live work. True means the caller
 * returns early; each refusal tells the user why.
 * @param {DryRunViewerDeps} deps - Capture dependencies.
 * @returns {boolean} Whether the preview refuses to run.
 */
function previewBlocked(deps) {
    if (getMainApi() !== CHAT_COMPLETION_API) {
        toastr.warning('Dry-Run Preview needs a Chat Completion connection.', TOAST_TITLE);
        return true;
    }
    if (deps.gate?.isFrozen()) {
        toastr.warning('Wait for the current generation to finish.', TOAST_TITLE);
        return true;
    }
    if (deps.queue?.isBusy()) {
        toastr.warning('Summarization is running. Wait for it to finish.', TOAST_TITLE);
        return true;
    }
    return false;
}

/**
 * @param {DryRunViewerDeps} deps - Capture dependencies.
 * @returns {Promise<void>} When the warm-up settles.
 */
async function warmPreviewPages(deps) {
    try {
        await deps.warmPages?.();
    } catch (e) {
        warn('Dry-Run Preview page warm-up failed:', e);
    }
}

/**
 * Expand the clone, run the shared rewrite once, and diff capture facts.
 * @param {{ chat: unknown[], snapshot: import('./outgoing-context.js').OutgoingCaptureSnapshot | null }} captured - Chat and arrival facts.
 * @param {DryRunViewerDeps} deps - Capture dependencies.
 * @param {import('./outgoing-context.js').OutgoingContextWriter | null} writer - Shared writer.
 * @returns {DryRunPromptView} View model.
 */
function buildPreviewView(captured, deps, writer) {
    const settings = deps.getSettings?.() ?? getEffectiveSettings();
    const resolvePage =
        deps.resolveMicrofichePage ??
        writer?.resolveMicrofichePage ??
        createPlanPageReader(settings);
    const expanded = expandCapturedChat(captured.chat, resolvePage);
    const outgoing = applyOutgoingRewriteToPreview(expanded.chat, writer, settings);
    const current = captureOutgoingSnapshot({ writer, settings });
    return describeDryRunPrompt({
        chat: expanded.chat,
        epoch: getSummaryStoreMutationEpoch(getChatStore()),
        settings,
        resolvedMarkers: expanded.resolvedMarkers,
        unresolvedMarkers: expanded.unresolvedMarkers,
        promptManagerReady: Boolean(getPromptManager()?.serviceSettings),
        captureDivergences: deriveOutgoingDivergence(captured.snapshot, current),
        outgoing,
    });
}

/**
 * Status-tab button trigger; the slash command calls openDryRunPreview directly.
 * @returns {void}
 */
export function bindDryRunPreviewButton() {
    $(document).on('click', '#sc_dryrun_preview', () => {
        void openDryRunPreview();
    });
}
