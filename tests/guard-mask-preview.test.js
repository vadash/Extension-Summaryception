import { describe, expect, it, vi } from 'vitest';

import { formatMicroficheMarker } from '../src/core/microfiche-transport.js';
import { initDryRunViewer, openDryRunPreview } from '../src/entry/dryrun-viewer.js';
import { installSummaryContext, makeToastrMock } from './test-helpers.js';

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

/** Guard-mask settings plus the viewer toggles openDryRunPreview reads. */
function makeGuardSettings(overrides = {}) {
    return {
        enabled: true,
        uiMode: 'advanced',
        microficheFrozenRawImages: false,
        guardMask: true,
        guardMaskMemory: true,
        ...overrides,
    };
}

/**
 * Install the host facade state openDryRunPreview reads: chat-completion API,
 * one event source, chat-completion settings, and the effective settings the
 * host would expose.
 * @param {{ eventSource: ReturnType<typeof makeEventSource>, settings?: object }} input
 * @returns {object} Foundation context mocks.
 */
function installPromptHost({ eventSource, settings = makeGuardSettings() }) {
    const ctx = installSummaryContext({ promptManager: { serviceSettings: {} }, settings });
    const mocks = /** @type {any} */ (globalThis).summaryceptionFoundationMocks.context;
    mocks.getMainApi.mockReturnValue('openai');
    mocks.getEventSource.mockReturnValue(eventSource);
    mocks.getEventTypes.mockReturnValue({ CHAT_COMPLETION_PROMPT_READY: EVENT_NAME });
    mocks.getPromptManager.mockImplementation(() => ctx.promptManager ?? null);
    return mocks;
}

/**
 * Run the preview end to end and return the rendered view.
 * @param {{ chat: unknown[], settings?: object, resolvePage?: (pageIndex: number) => unknown }} input
 * @returns {Promise<{ view: any, eventSource: ReturnType<typeof makeEventSource> }>}
 */
async function capturePreview({
    chat,
    settings = makeGuardSettings(),
    resolvePage = () => undefined,
}) {
    const eventSource = makeEventSource();
    installPromptHost({ eventSource, settings });
    globalThis.toastr = makeToastrMock();
    const showView = vi.fn();
    initDryRunViewer({
        gate: /** @type {any} */ ({ isFrozen: () => false }),
        queue: /** @type {any} */ ({ isBusy: () => false }),
        resolveMicrofichePage: resolvePage,
        warmPages: async () => {},
        triggerDryRun: async () => {
            eventSource.emit(EVENT_NAME, { chat, dryRun: true });
        },
        showView,
        getSettings: () => settings,
    });

    await openDryRunPreview();

    expect(showView).toHaveBeenCalledTimes(1);
    return { view: showView.mock.calls[0][0], eventSource };
}

describe('openDryRunPreview guard mask', () => {
    it('masks user and assistant string content when both guard toggles are on', async () => {
        const chat = [
            { role: 'user', content: 'hello world' },
            { role: 'assistant', content: 'general kenobi here' },
        ];

        const { view } = await capturePreview({ chat });

        expect(view.chat[0].content).toBe('hello$$world');
        expect(view.chat[1].content).toBe('general$$kenobi$$here');
    });

    it('leaves user and assistant text raw when the guard is off', async () => {
        const chat = [
            { role: 'user', content: 'hello world' },
            { role: 'assistant', content: 'general kenobi here' },
        ];

        const { view } = await capturePreview({
            chat,
            settings: makeGuardSettings({ guardMask: false, guardMaskMemory: false }),
        });

        expect(view.chat[0].content).toBe('hello world');
        expect(view.chat[1].content).toBe('general kenobi here');
    });

    it('masks expanded text parts and leaves image URLs intact', async () => {
        const marker = formatMicroficheMarker(0);
        const chat = [{ role: 'user', content: `before ${marker} after` }];

        const { view } = await capturePreview({
            chat,
            resolvePage: (pageIndex) => PAGES.get(pageIndex),
        });

        const content = /** @type {any[]} */ (view.chat[0].content);
        expect(Array.isArray(content)).toBe(true);
        expect(content.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
            'before$$',
            '$$after',
        ]);
        expect(content.filter((part) => part.type === 'image_url')).toEqual([
            { type: 'image_url', image_url: { url: PAGES.get(0).dataUrl } },
        ]);
        expect(view.resolvedMarkers).toBe(1);
        expect(view.imageParts).toBe(1);
    });

    it('renders the masked clone without mutating the captured array', async () => {
        const marker = formatMicroficheMarker(0);
        const chat = [
            { role: 'user', content: `hello world ${marker} tail` },
            { role: 'assistant', content: 'assistant reply' },
        ];
        const snapshot = JSON.parse(JSON.stringify(chat));

        const { view } = await capturePreview({
            chat,
            resolvePage: (pageIndex) => PAGES.get(pageIndex),
        });

        expect(chat).toEqual(snapshot);
        expect(chat[0].content).toBe(`hello world ${marker} tail`);
        expect(view.chat).not.toBe(chat);
        expect(view.chat[0]).not.toBe(chat[0]);
        const content = /** @type {any[]} */ (view.chat[0].content);
        expect(content.filter((part) => part.type === 'text').map((part) => part.text)).toEqual([
            'hello$$world$$',
            '$$tail',
        ]);
    });

    it('leaves a system-role memory slot unmasked when memory masking is off', async () => {
        const chat = [{ role: 'system', content: 'memory slot stays raw here' }];

        const { view } = await capturePreview({
            chat,
            settings: makeGuardSettings({ guardMaskMemory: false }),
        });

        expect(view.chat[0].content).toBe('memory slot stays raw here');
    });
});
