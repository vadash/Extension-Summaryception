import { describe, expect, it, vi } from 'vitest';

import { EXTENSION_PROMPT_POSITIONS, EXTENSION_PROMPT_ROLES } from '../src/foundation/constants.js';
import { rewriteOutgoingPrompt } from '../src/core/outgoing-rewrite.js';
import { buildOutgoingContext } from '../src/entry/outgoing-context.js';
import { formatMicroficheMarker } from '../src/core/microfiche-transport.js';
import { initDryRunViewer, openDryRunPreview } from '../src/entry/dryrun-viewer.js';
import { installSummaryContext, makeToastrMock } from './test-helpers.js';

const EVENT_NAME = 'chat_completion_prompt_ready';
const B = '\u2800';

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
    mocks.getActiveModelName.mockReturnValue('gemini-2.5-pro');
    mocks.getEventSource.mockReturnValue(eventSource);
    mocks.getEventTypes.mockReturnValue({ CHAT_COMPLETION_PROMPT_READY: EVENT_NAME });
    mocks.getPromptManager.mockImplementation(() => ctx.promptManager ?? null);
    return mocks;
}

function makeWriter(text = '', role = EXTENSION_PROMPT_ROLES.SYSTEM) {
    const options = {
        position: EXTENSION_PROMPT_POSITIONS.IN_CHAT,
        depth: 0,
        scan: false,
        role,
    };
    return {
        getSlotFacts: () => ({
            text,
            options: { ...options },
            hasSlot: text !== '',
            lastInjectionKey: JSON.stringify({ text, options }),
        }),
        resolveMicrofichePage: () => undefined,
    };
}

/**
 * Run the preview end to end and return the rendered view.
 * @param {{ chat: unknown[], settings?: object, resolvePage?: (pageIndex: number) => unknown, writer?: object, mutateAfterCapture?: () => void }} input
 * @returns {Promise<{ view: any, eventSource: ReturnType<typeof makeEventSource> }>}
 */
async function capturePreview({
    chat,
    settings = makeGuardSettings(),
    resolvePage = () => undefined,
    writer = makeWriter(),
    mutateAfterCapture,
}) {
    const eventSource = makeEventSource();
    installPromptHost({ eventSource, settings });
    globalThis.toastr = makeToastrMock();
    const showView = vi.fn();
    initDryRunViewer({
        gate: /** @type {any} */ ({ isFrozen: () => false }),
        queue: /** @type {any} */ ({ isBusy: () => false }),
        resolveMicrofichePage: resolvePage,
        writer: /** @type {any} */ (writer),
        warmPages: async () => {},
        triggerDryRun: async () => {
            eventSource.emit(EVENT_NAME, { chat, dryRun: true });
            mutateAfterCapture?.();
        },
        showView,
        getSettings: () => settings,
    });

    await openDryRunPreview();

    expect(showView).toHaveBeenCalledTimes(1);
    return { view: showView.mock.calls[0][0], eventSource };
}

describe('openDryRunPreview shared rewrite', () => {
    it('masks user and assistant string content through the shared core operation', async () => {
        const chat = [
            { role: 'user', content: 'hello world' },
            { role: 'assistant', content: 'general kenobi here' },
        ];

        const { view } = await capturePreview({ chat });

        expect(view.chat[0].content).toBe(`hello${B}world`);
        expect(view.chat[1].content).toBe(`general${B}kenobi${B}here`);
        expect(view.outgoing.slotStatus).toBe('absent');
    });

    it('matches the live rewrite on the same input', async () => {
        const chat = [
            { role: 'user', content: 'hello world' },
            { role: 'assistant', content: 'general kenobi here' },
        ];
        const settings = makeGuardSettings();
        const writer = makeWriter();

        const { view } = await capturePreview({ chat, settings, writer });

        const live = structuredClone(chat);
        const context = buildOutgoingContext(live, { writer, settings });
        rewriteOutgoingPrompt(live, context);

        expect(view.chat).toEqual(live);
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
            `before${B}`,
            `${B}after`,
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
            `hello${B}world${B}`,
            `${B}tail`,
        ]);
    });

    it('skips the placed slot and masks identical text outside it', async () => {
        const slotText = 'MEMORY <preserved>exact bytes</preserved>';
        const chat = [
            { role: 'system', content: slotText },
            { role: 'user', content: 'hello  world' },
            { role: 'user', content: slotText },
        ];
        const writer = makeWriter(slotText, EXTENSION_PROMPT_ROLES.SYSTEM);

        const { view } = await capturePreview({
            chat,
            settings: makeGuardSettings({ guardMaskMemory: false }),
            writer,
        });

        expect(view.chat[0].content).toBe(slotText);
        expect(view.chat[1].content).toBe(`hello${B}world`);
        expect(view.chat[2].content).toBe(`MEMORY${B}<preserved>exact${B}bytes</preserved>`);
        expect(view.outgoing.slotStatus).toBe('skipped');
    });

    it('reports a slot change when memory moves between capture and transform', async () => {
        const chat = [{ role: 'user', content: 'hello world' }];
        let key = 'key-one';
        const writer = {
            getSlotFacts: () => ({
                text: 'MEMORY one',
                options: {
                    position: EXTENSION_PROMPT_POSITIONS.IN_CHAT,
                    depth: 0,
                    scan: false,
                    role: EXTENSION_PROMPT_ROLES.SYSTEM,
                },
                hasSlot: true,
                lastInjectionKey: key,
            }),
            resolveMicrofichePage: () => undefined,
        };

        const { view } = await capturePreview({
            chat,
            writer,
            mutateAfterCapture: () => {
                key = 'key-two';
            },
        });

        expect(view.divergences.map((entry) => entry.kind)).toContain('slot-changed');
    });
});
