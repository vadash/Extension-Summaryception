import { describe, expect, it, vi } from 'vitest';

import {
    captureHostDryRun,
    copyPromptChat,
    describeDryRunPrompt,
    expandCapturedChat,
    initDryRunViewer,
    openDryRunPreview,
} from '../src/entry/dryrun-viewer.js';
import { onChatCompletionPromptReady } from '../src/entry/events.js';
import { formatMicroficheMarker } from '../src/core/microfiche-transport.js';
import { createJQueryHarness, installSummaryContext, makeToastrMock } from './test-helpers.js';

const EVENT_NAME = 'chat_completion_prompt_ready';

const PAGES = new Map([[0, { dataUrl: 'data:image/png;base64,PAGE0', text: 'PAGE ZERO TEXT' }]]);

/** Build one event source whose listeners a test can emit through. */
function makeEventSource() {
    /** @type {Map<string, Array<(payload: unknown) => void>>} */
    const handlers = new Map();
    return {
        on: vi.fn((name, handler) => {
            handlers.set(name, [...(handlers.get(name) ?? []), handler]);
        }),
        removeListener: vi.fn((name, handler) => {
            handlers.set(
                name,
                (handlers.get(name) ?? []).filter((entry) => entry !== handler),
            );
        }),
        emit(name, payload) {
            for (const handler of handlers.get(name) ?? []) {
                handler(payload);
            }
        },
        count(name) {
            return (handlers.get(name) ?? []).length;
        },
    };
}

/** Empty summary store with a Microfiche-free settings shape. */
function makeSettings(overrides = {}) {
    return { microficheMemoryImages: false, microficheFrozenRawImages: false, ...overrides };
}

/**
 * Install the host facade state openDryRunPreview reads: chat-completion API,
 * one event source, and chat-completion settings marked ready.
 * @param {{ eventSource: ReturnType<typeof makeEventSource> }} input
 * @returns {object} Foundation context mocks.
 */
function installPromptHost({ eventSource }) {
    const ctx = installSummaryContext({ promptManager: { serviceSettings: {} } });
    const mocks = /** @type {any} */ (globalThis).summaryceptionFoundationMocks.context;
    mocks.getMainApi.mockReturnValue('openai');
    mocks.getEventSource.mockReturnValue(eventSource);
    mocks.getEventTypes.mockReturnValue({ CHAT_COMPLETION_PROMPT_READY: EVENT_NAME });
    mocks.getPromptManager.mockImplementation(() => ctx.promptManager ?? null);
    return mocks;
}

describe('expandCapturedChat', () => {
    it('expands markers on the clone and leaves the captured payload untouched', () => {
        const raw = [
            {
                role: 'system',
                content: `memory ${formatMicroficheMarker(0)} tail ${formatMicroficheMarker(3)}`,
            },
        ];
        const snapshot = JSON.parse(JSON.stringify(raw));

        const expanded = expandCapturedChat(raw, (pageIndex) => PAGES.get(pageIndex));

        expect(raw).toEqual(snapshot);
        expect(expanded.chat).not.toBe(raw);
        expect(expanded.chat[0]).not.toBe(raw[0]);
        expect(expanded.chat[0].content).toContainEqual({
            type: 'image_url',
            image_url: { url: PAGES.get(0).dataUrl },
        });
        expect(expanded.chat[0].content).toContainEqual({
            type: 'text',
            text: PAGES.get(0).text,
        });
        expect(expanded.resolvedMarkers).toBe(1);
        expect(expanded.unresolvedMarkers).toEqual([3]);
        expect(JSON.stringify(expanded.chat)).toContain(formatMicroficheMarker(3));
    });

    it('keeps markers literal when the page reader resolves nothing', () => {
        const raw = [{ role: 'user', content: `before ${formatMicroficheMarker(1)} after` }];
        const expanded = expandCapturedChat(raw, () => undefined);
        expect(expanded.resolvedMarkers).toBe(0);
        expect(expanded.chat[0].content).toBe(raw[0].content);
        expect(expanded.unresolvedMarkers).toEqual([1]);
    });
});

describe('describeDryRunPrompt', () => {
    it('reports epoch, toggles, payload size, and image parts', () => {
        const chat = [
            { role: 'user', content: 'hello' },
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'page' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                ],
            },
        ];
        const view = describeDryRunPrompt({
            chat,
            epoch: 7,
            settings: makeSettings({ microficheMemoryImages: true }),
            resolvedMarkers: 1,
            unresolvedMarkers: [],
            promptManagerReady: true,
        });

        expect(view.epoch).toBe(7);
        expect(view.toggles).toEqual({ memoryImages: true, frozenRawImages: false });
        expect(view.imageParts).toBe(1);
        expect(view.resolvedMarkers).toBe(1);
        expect(view.payloadBytes).toBe(new TextEncoder().encode(JSON.stringify(chat)).length);
        expect(view.divergences).toEqual([]);
    });

    it('flags unsquashed systems and pre-settings-ready assembly', () => {
        const chat = [
            { role: 'system', content: 'a' },
            { role: 'system', content: 'b' },
            { role: 'system', content: 'c' },
            { role: 'user', content: 'x' },
        ];
        const view = describeDryRunPrompt({
            chat,
            epoch: 0,
            settings: makeSettings(),
            resolvedMarkers: 0,
            unresolvedMarkers: [4],
            promptManagerReady: false,
        });

        expect(view.divergences.map((entry) => entry.kind)).toEqual([
            'unsquashed-systems',
            'pre-settings-ready',
        ]);
        expect(view.divergences[0].count).toBe(2);
        expect(view.unresolvedMarkers).toEqual([4]);
    });

    it('ignores named system messages the host never squashes', () => {
        const chat = [
            { role: 'system', content: 'a', name: 'scene' },
            { role: 'system', content: 'b', name: 'scene' },
        ];
        const view = describeDryRunPrompt({
            chat,
            epoch: 0,
            settings: makeSettings(),
            resolvedMarkers: 0,
            unresolvedMarkers: [],
            promptManagerReady: true,
        });
        expect(view.divergences).toEqual([]);
    });
});

describe('captureHostDryRun', () => {
    it('arms the listener before the trigger fires and detaches after one event', async () => {
        const eventSource = makeEventSource();
        const order = [];
        const eventTypes = { CHAT_COMPLETION_PROMPT_READY: EVENT_NAME };
        const mocks = /** @type {any} */ (globalThis).summaryceptionFoundationMocks.context;
        mocks.getEventSource.mockReturnValue(eventSource);
        mocks.getEventTypes.mockReturnValue(eventTypes);

        const captured = await captureHostDryRun({
            trigger: async () => {
                order.push(`trigger:${eventSource.count(EVENT_NAME)}`);
                eventSource.emit(EVENT_NAME, { chat: [{ role: 'user', content: 'x' }] });
                eventSource.emit(EVENT_NAME, { chat: [{ role: 'user', content: 'later' }] });
            },
        });

        expect(order).toEqual(['trigger:1']);
        expect(captured).toEqual([{ role: 'user', content: 'x' }]);
        expect(eventSource.count(EVENT_NAME)).toBe(0);
    });

    it('resolves null on timeout and detaches', async () => {
        const eventSource = makeEventSource();
        const mocks = /** @type {any} */ (globalThis).summaryceptionFoundationMocks.context;
        mocks.getEventSource.mockReturnValue(eventSource);
        mocks.getEventTypes.mockReturnValue({ CHAT_COMPLETION_PROMPT_READY: EVENT_NAME });

        const captured = await captureHostDryRun({
            trigger: async () => {},
            timeoutMs: 5,
        });

        expect(captured).toBeNull();
        expect(eventSource.count(EVENT_NAME)).toBe(0);
    });

    it('resolves null when the host dry run throws', async () => {
        const eventSource = makeEventSource();
        const mocks = /** @type {any} */ (globalThis).summaryceptionFoundationMocks.context;
        mocks.getEventSource.mockReturnValue(eventSource);
        mocks.getEventTypes.mockReturnValue({ CHAT_COMPLETION_PROMPT_READY: EVENT_NAME });

        const captured = await captureHostDryRun({
            trigger: async () => {
                throw new Error('no character');
            },
        });

        expect(captured).toBeNull();
        expect(eventSource.count(EVENT_NAME)).toBe(0);
    });
});

describe('copyPromptChat', () => {
    it('copies exactly the captured chat array with full data URLs', async () => {
        const writeText = vi.fn(async () => {});
        Object.defineProperty(globalThis.navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        });
        globalThis.toastr = makeToastrMock();
        const chat = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'page' },
                    { type: 'image_url', image_url: { url: PAGES.get(0).dataUrl } },
                ],
            },
        ];

        const payload = await copyPromptChat(chat);

        expect(writeText).toHaveBeenCalledWith(payload);
        expect(payload.startsWith('[')).toBe(true);
        const parsed = JSON.parse(payload);
        expect(parsed).toEqual(chat);
        expect(parsed[0].content[1].image_url.url).toBe(PAGES.get(0).dataUrl);
        delete globalThis.navigator.clipboard;
    });
});

describe('openDryRunPreview', () => {
    it('refuses a non chat-completion host API', async () => {
        const eventSource = makeEventSource();
        const mocks = installPromptHost({ eventSource });
        mocks.getMainApi.mockReturnValue('textgenerationwebui');
        globalThis.toastr = makeToastrMock();
        const warmPages = vi.fn(async () => {});
        const triggerDryRun = vi.fn(async () => {});
        const showView = vi.fn();
        initDryRunViewer({
            gate: /** @type {any} */ ({ isFrozen: () => false }),
            queue: /** @type {any} */ ({ isBusy: () => false }),
            resolveMicrofichePage: () => undefined,
            warmPages,
            triggerDryRun,
            showView,
        });

        await openDryRunPreview();

        expect(warmPages).not.toHaveBeenCalled();
        expect(triggerDryRun).not.toHaveBeenCalled();
        expect(showView).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).toHaveBeenCalled();
    });

    it('refuses while the foreground gate is frozen', async () => {
        const eventSource = makeEventSource();
        installPromptHost({ eventSource });
        globalThis.toastr = makeToastrMock();
        const warmPages = vi.fn(async () => {});
        const triggerDryRun = vi.fn(async () => {});
        const showView = vi.fn();
        initDryRunViewer({
            gate: /** @type {any} */ ({ isFrozen: () => true }),
            queue: /** @type {any} */ ({ isBusy: () => false }),
            resolveMicrofichePage: () => undefined,
            warmPages,
            triggerDryRun,
            showView,
        });

        await openDryRunPreview();

        expect(warmPages).not.toHaveBeenCalled();
        expect(triggerDryRun).not.toHaveBeenCalled();
        expect(showView).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).toHaveBeenCalled();
    });

    it('refuses while the work gate is busy', async () => {
        const eventSource = makeEventSource();
        installPromptHost({ eventSource });
        globalThis.toastr = makeToastrMock();
        const warmPages = vi.fn(async () => {});
        const triggerDryRun = vi.fn(async () => {});
        const showView = vi.fn();
        initDryRunViewer({
            gate: /** @type {any} */ ({ isFrozen: () => false }),
            queue: /** @type {any} */ ({ isBusy: () => true }),
            resolveMicrofichePage: () => undefined,
            warmPages,
            triggerDryRun,
            showView,
        });

        await openDryRunPreview();

        expect(warmPages).not.toHaveBeenCalled();
        expect(triggerDryRun).not.toHaveBeenCalled();
        expect(showView).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).toHaveBeenCalled();
    });

    it('warms pages, captures the dry run, and renders the expanded clone', async () => {
        const eventSource = makeEventSource();
        installPromptHost({ eventSource });
        globalThis.toastr = makeToastrMock();
        const order = [];
        const raw = [
            {
                role: 'system',
                content: `memory ${formatMicroficheMarker(0)} tail`,
            },
        ];
        const rawSnapshot = JSON.parse(JSON.stringify(raw));
        const warmPages = vi.fn(async () => {
            order.push('warm');
        });
        const triggerDryRun = vi.fn(async () => {
            order.push('generate');
            eventSource.emit(EVENT_NAME, { chat: raw, dryRun: true });
        });
        const showView = vi.fn();
        initDryRunViewer({
            gate: /** @type {any} */ ({ isFrozen: () => false }),
            queue: /** @type {any} */ ({ isBusy: () => false }),
            resolveMicrofichePage: (pageIndex) => PAGES.get(pageIndex),
            warmPages,
            triggerDryRun,
            showView,
            getSettings: () => /** @type {any} */ (makeSettings({ microficheMemoryImages: true })),
        });

        await openDryRunPreview();

        expect(order).toEqual(['warm', 'generate']);
        expect(eventSource.count(EVENT_NAME)).toBe(0);
        expect(raw).toEqual(rawSnapshot);
        expect(showView).toHaveBeenCalledTimes(1);
        const view = showView.mock.calls[0][0];
        expect(view.chat[0].content).toContainEqual({
            type: 'image_url',
            image_url: { url: PAGES.get(0).dataUrl },
        });
        expect(view.imageParts).toBe(1);
        expect(view.resolvedMarkers).toBe(1);
        expect(view.toggles.memoryImages).toBe(true);
    });

    it('reports a missing prompt without opening the viewer', async () => {
        const eventSource = makeEventSource();
        installPromptHost({ eventSource });
        globalThis.toastr = makeToastrMock();
        const showView = vi.fn();
        initDryRunViewer({
            gate: /** @type {any} */ ({ isFrozen: () => false }),
            queue: /** @type {any} */ ({ isBusy: () => false }),
            resolveMicrofichePage: () => undefined,
            warmPages: async () => {},
            triggerDryRun: async () => {
                eventSource.emit(EVENT_NAME, { dryRun: true });
            },
            showView,
        });

        await openDryRunPreview();

        expect(showView).not.toHaveBeenCalled();
        expect(globalThis.toastr.warning).toHaveBeenCalled();
    });
});

describe('entry wiring', () => {
    it('prefers the writer page reader and warm-up passed to bindUIEvents', async () => {
        vi.resetModules();
        const eventSource = makeEventSource();
        installPromptHost({ eventSource });
        const ctx = globalThis.SillyTavern.getContext();
        globalThis.toastr = makeToastrMock();
        globalThis.document = {};
        globalThis.$ = createJQueryHarness().$;
        const raw = [{ role: 'system', content: `memory ${formatMicroficheMarker(0)} tail` }];
        ctx.generate = async () => {
            eventSource.emit(EVENT_NAME, { chat: raw, dryRun: true });
        };
        const warmPages = vi.fn(async () => {});
        const resolveMicrofichePage = vi.fn((pageIndex) => PAGES.get(pageIndex));

        const { bindUIEvents } = await import('../src/entry/ui-events.js');
        const { openDryRunPreview: openWiredPreview } =
            await import('../src/entry/dryrun-viewer.js');
        bindUIEvents({
            notify: null,
            gate: /** @type {any} */ ({ isFrozen: () => false }),
            queue: /** @type {any} */ ({ isBusy: () => false, request: async () => {} }),
            manualRunnerDeps: /** @type {any} */ ({ queue: { isBusy: () => false } }),
            warmPages,
            resolveMicrofichePage,
        });

        await openWiredPreview();

        expect(warmPages).toHaveBeenCalledTimes(1);
        expect(resolveMicrofichePage).toHaveBeenCalledWith(0);
    });
});

describe('prod prompt-ready path', () => {
    it('leaves a dry-run payload untouched', () => {
        const chat = [{ role: 'system', content: `memory ${formatMicroficheMarker(0)} tail` }];
        onChatCompletionPromptReady({ chat, dryRun: true }, true, {
            resolveMicrofichePage: (pageIndex) => PAGES.get(pageIndex),
        });
        expect(chat[0].content).toBe(`memory ${formatMicroficheMarker(0)} tail`);
    });
});
