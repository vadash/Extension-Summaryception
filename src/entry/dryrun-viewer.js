/**
 * Dry-Run Preview: capture the host's dry-run chat completion, expand the
 * Microfiche markers on a clone, re-apply the outgoing role/Guard Mask seam to
 * that clone, and render the read-only prompt viewer (ADR-0041, ADR-0043).
 * The live payload never mutates here; the one-shot listener reads
 * `eventData.chat`, clones it, and the prod `onChatCompletionPromptReady`
 * dry-run early return stays untouched.
 */

import { TOAST_TITLE } from '../foundation/constants.js';
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
} from '../core/microfiche-transport.js';
import { buildInjection } from '../core/memory-injection.js';
import { buildMicroficheRawSlice } from '../core/microfiche-raw-slice.js';
import { maskUserRoleAsAssistantInGenerateData } from '../core/assistant-role-mask.js';
import { renderMicrofichePages } from '../core/microfiche-pages.js';

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
 * @property {unknown[]} chat - Expanded clone with the outgoing seam transforms; the clipboard payload.
 * @property {number} epoch - Mutation Epoch the captured memory was sealed for.
 * @property {{ memoryImages: boolean, frozenRawImages: boolean }} toggles - Image region toggles.
 * @property {number} payloadBytes - Serialized size of the captured chat.
 * @property {number} imageParts - Image parts present in the expanded clone.
 * @property {number} resolvedMarkers - Marker swaps performed on the clone.
 * @property {(number | string)[]} unresolvedMarkers - Page labels whose markers survived.
 * @property {Array<{ kind: string, count?: number }>} divergences - Known dry-run assembly differences.
 */

/**
 * @typedef {object} DryRunViewerDeps
 * @property {import('../core/foreground-gate.js').ForegroundGate} gate - Refuses the capture while frozen.
 * @property {import('../core/summarizer-queue.js').SummarizerQueue} queue - Refuses the capture while work is live.
 * @property {(pageIndex: number, region?: import('../core/microfiche-transport.js').MicroficheRegion) => MicrofichePageRef | undefined} [resolveMicrofichePage] - Page reader; the composition root passes `writer.resolveMicrofichePage`.
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
 * wiring). It re-renders the same sealed plans through the core renderer, so
 * the pixels match what the writer sealed for this Mutation Epoch; the
 * composition root normally injects `writer.resolveMicrofichePage` instead.
 * Both regions render lazily: memory from the memory plan and raw pages from a
 * fresh Raw Seal slice, so a marker-free prompt draws nothing.
 * @param {ExtensionSettings} settings - Effective settings.
 * @returns {(pageIndex: number, region?: import('../core/microfiche-transport.js').MicroficheRegion) => MicrofichePageRef | undefined} Page reader.
 */
export function createPlanPageReader(settings) {
    /** @type {{ memory: import('../core/microfiche-pages.js').MicrofichePage[], raw: import('../core/microfiche-pages.js').MicrofichePage[] } | null} */
    let pages = null;
    const readPages = () => {
        if (pages !== null) {
            return pages;
        }
        const store = getChatStore();
        const rawTexts =
            settings?.microficheFrozenRawImages === true
                ? buildMicroficheRawSlice(getChat(), store, settings)
                : null;
        const injection = buildInjection(store.layers, settings, null, rawTexts);
        pages = {
            memory:
                injection.microfiche && injection.microfiche.imageTexts.length > 0
                    ? renderMicrofichePages(
                          injection.microfiche.imageTexts,
                          injection.microfiche.shape,
                          createBrowserCanvas,
                      )
                    : [],
            raw:
                injection.microficheRaw && injection.microficheRaw.imageTexts.length > 0
                    ? renderMicrofichePages(
                          injection.microficheRaw.imageTexts,
                          injection.microficheRaw.shape,
                          createBrowserCanvas,
                      )
                    : [],
        };
        return pages;
    };
    return (pageIndex, region = 'memory') =>
        (region === 'raw' ? readPages().raw : readPages().memory)[pageIndex];
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
                const label =
                    marker.region === 'raw' ? `${marker.pageIndex}:raw` : marker.pageIndex;
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
 * Re-apply the live outgoing seam (role rewrite + Guard Mask) to the preview
 * clone. The host dry run early-returns before GENERATE_AFTER_DATA, so the
 * capture is pre-transform by construction (ADR-0044). Clone-only; the live
 * payload never mutates here.
 * @param {unknown[]} chat - Expanded preview clone.
 * @param {ExtensionSettings} settings - Effective settings.
 * @returns {void}
 */
export function applyOutgoingSeamToPreview(chat, settings) {
    try {
        maskUserRoleAsAssistantInGenerateData(chat, settings);
    } catch (e) {
        warn('Dry-Run Preview guard mask failed:', e);
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
 * @param {{ chat: unknown[], epoch: number, settings: ExtensionSettings, resolvedMarkers: number, unresolvedMarkers: (number | string)[], promptManagerReady: boolean }} input - Capture facts.
 * @returns {DryRunPromptView} View model.
 */
export function describeDryRunPrompt({
    chat,
    epoch,
    settings,
    resolvedMarkers,
    unresolvedMarkers,
    promptManagerReady,
}) {
    const toggles = {
        memoryImages: Boolean(settings?.microficheMemoryImages),
        frozenRawImages: Boolean(settings?.microficheFrozenRawImages),
    };
    const imageParts = countImageParts(chat);
    /** @type {Array<{ kind: string, count?: number }>} */
    const divergences = [];
    const unsquashed = countUnsquashedSystems(chat);
    if (unsquashed > 0) {
        divergences.push({ kind: 'unsquashed-systems', count: unsquashed });
    }
    if (!promptManagerReady) {
        divergences.push({ kind: 'pre-settings-ready' });
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
 * @param {{ trigger: () => Promise<unknown>, timeoutMs?: number }} options - Trigger and timeout.
 * @returns {Promise<unknown[] | null>} Captured chat, or null when none arrived.
 */
export async function captureHostDryRun({ trigger, timeoutMs = CAPTURE_TIMEOUT_MS }) {
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
            settle(Array.isArray(chat) ? chat : null);
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
    if (getMainApi() !== CHAT_COMPLETION_API) {
        toastr.warning('Dry-Run Preview needs a Chat Completion connection.', TOAST_TITLE);
        return;
    }
    if (deps.gate?.isFrozen()) {
        toastr.warning('Wait for the current generation to finish.', TOAST_TITLE);
        return;
    }
    if (deps.queue?.isBusy()) {
        toastr.warning('Summarization is running. Wait for it to finish.', TOAST_TITLE);
        return;
    }
    try {
        await deps.warmPages?.();
    } catch (e) {
        warn('Dry-Run Preview page warm-up failed:', e);
    }
    const captured = await captureHostDryRun({
        trigger: deps.triggerDryRun ?? runDryRunGenerate,
    });
    if (!captured) {
        toastr.warning(
            'Dry run produced no prompt. Check the character and chat-completion settings.',
            TOAST_TITLE,
        );
        return;
    }
    const settings = deps.getSettings?.() ?? getEffectiveSettings();
    const resolvePage = deps.resolveMicrofichePage ?? createPlanPageReader(settings);
    const expanded = expandCapturedChat(captured, resolvePage);
    applyOutgoingSeamToPreview(expanded.chat, settings);
    const view = describeDryRunPrompt({
        chat: expanded.chat,
        epoch: getSummaryStoreMutationEpoch(getChatStore()),
        settings,
        resolvedMarkers: expanded.resolvedMarkers,
        unresolvedMarkers: expanded.unresolvedMarkers,
        promptManagerReady: Boolean(getPromptManager()?.serviceSettings),
    });
    debug(
        `Dry-Run Preview captured ${view.chat.length} messages, ${view.imageParts} image part(s).`,
    );
    await showDryRunView(view, deps);
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
