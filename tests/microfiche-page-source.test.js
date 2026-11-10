import { describe, expect, it, vi } from 'vitest';

import {
    getSummaryStoreMutationEpoch,
    bumpSummaryStoreMutationEpoch,
    getChatStore,
} from '../src/foundation/chat-store.js';
import { MEMORY_MODES } from '../src/foundation/constants.js';
import { getEffectiveSettings } from '../src/foundation/settings.js';
import { buildInjection } from '../src/core/memory-injection.js';
import { resolveMicroficheShape } from '../src/core/microfiche-paginate.js';
import { buildMicrofichePlan } from '../src/core/microfiche-policy.js';
import { createMicrofichePageSource } from '../src/core/microfiche-pages.js';
import {
    extractMicroficheMarkers,
    formatMicroficheMarker,
    formatMicroficheRawMarker,
} from '../src/core/microfiche-transport.js';
import { describeDryRunPrompt, expandCapturedChat } from '../src/entry/dryrun-viewer.js';
import { onChatChanged, onChatCompletionPromptReady } from '../src/entry/events.js';
import {
    installSummaryContext,
    makeMemoryInjectionWriter,
    makeMessages,
    makeSummaryStore,
} from './test-helpers.js';

const GEMINI_KNOBS = {
    microficheFont: '8x8',
    microficheCellWidth: 8,
    microficheCellHeight: 22,
    microficheStretch: false,
    microficheVariant: 'bw',
    microficheStopwordDim: false,
    microficheColumns: 1,
    microficheLineRepeat: 1,
    microficheFrameSize: 2048,
};

const MICROFICHE_SETTINGS = {
    memoryMode: MEMORY_MODES.MICROFICHE,
    microficheGeometry: 'gemini',
    microficheKeepRaw: 0,
    microficheImageCap: 8,
    microficheFrameSize: 512,
};

function makePlan(imageTexts, shape = resolveMicroficheShape(GEMINI_KNOBS)) {
    return { shape, imageTexts };
}

function makeFakeRenderer() {
    const calls = [];
    function renderPage(text, shape) {
        calls.push({ text, shape });
        return { dataUrl: `data:fake:${text}`, text };
    }
    return { renderPage, calls };
}

function makeFakeCanvas() {
    return {
        width: 0,
        height: 0,
        toDataURL(mime) {
            return `data:image/png;fake:${this.width}x${this.height}:${mime}`;
        },
    };
}

function makeFakeContext(calls, pageIndex) {
    const ctx = {
        fillStyle: '#000000',
        font: '',
        textBaseline: '',
        textAlign: '',
        fillText(ch, x, y) {
            calls.push({ type: 'fillText', ch, x, y, fillStyle: ctx.fillStyle, page: pageIndex });
        },
        fillRect(x, y, w, h) {
            calls.push({ type: 'fillRect', x, y, w, h, fillStyle: ctx.fillStyle, page: pageIndex });
        },
    };
    return ctx;
}

function makeFakeFactory() {
    const calls = [];
    const canvases = [];
    function canvasFactory(width, height) {
        const pageIndex = canvases.length;
        const canvas = makeFakeCanvas();
        canvas.width = width;
        canvas.height = height;
        const ctx = makeFakeContext(calls, pageIndex);
        canvas.toDataURL = (mime) => {
            calls.push({ type: 'toDataURL', mime, page: pageIndex });
            return `data:image/png;fake:page${pageIndex}:${canvas.width}x${canvas.height}`;
        };
        canvases.push({ canvas, ctx, width, height });
        return { canvas, ctx };
    }
    return { canvasFactory, calls, canvases };
}

function installMicroficheContext({ layers, setExtensionPrompt, settings, chat } = {}) {
    const resolvedChat = chat ?? makeMessages(24);
    const resolvedLayers = layers ?? [
        [
            {
                text: `Snippet 0 ` + 'lorem ipsum dolor sit amet '.repeat(40),
                sourceMessageIds: [resolvedChat[0].sc_id],
            },
            {
                text: `Snippet 1 ` + 'lorem ipsum dolor sit amet '.repeat(40),
                sourceMessageIds: [resolvedChat[1].sc_id],
            },
        ],
        [
            {
                text: `Snippet 2 ` + 'lorem ipsum dolor sit amet '.repeat(40),
                sourceMessageIds: [resolvedChat[2].sc_id],
            },
            {
                text: `Snippet 3 ` + 'lorem ipsum dolor sit amet '.repeat(40),
                sourceMessageIds: [resolvedChat[3].sc_id],
            },
        ],
    ];
    installSummaryContext({
        chat: resolvedChat,
        metadata: { summaryception: makeSummaryStore({ layers: resolvedLayers }) },
        settings: settings ?? MICROFICHE_SETTINGS,
        setExtensionPrompt,
    });
    return resolvedChat;
}

function readAllPages(writer, limit = 16) {
    const pages = [];
    for (let index = 0; index < limit; index += 1) {
        const page = writer.resolveMicrofichePage(index);
        if (!page) {
            break;
        }
        pages.push(page);
    }
    return pages;
}

function readAllRawPages(writer, limit = 16) {
    const pages = [];
    for (let index = 0; index < limit; index += 1) {
        const page = writer.resolveMicrofichePage(index, 'raw');
        if (!page) {
            break;
        }
        pages.push(page);
    }
    return pages;
}

describe('microfiche page source', () => {
    it('serves each live page by index in plan order', () => {
        const texts = ['first page', 'second page', 'third page'];
        const { renderPage } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });

        source.update({ plan: makePlan(texts), epoch: 0 });

        expect(source.readPage(0)).toEqual({ dataUrl: 'data:fake:first page', text: 'first page' });
        expect(source.readPage(1).text).toBe('second page');
        expect(source.readPage(2).text).toBe('third page');
        expect(source.size()).toBe(3);
    });

    it('returns undefined before update and for indexes outside the live page list', () => {
        const { renderPage, calls } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });
        expect(source.readPage(0)).toBeUndefined();
        expect(calls.length).toBe(0);

        source.update({ plan: makePlan(['one', 'two']), epoch: 0 });
        const warmed = calls.length;
        expect(source.readPage(-1)).toBeUndefined();
        expect(source.readPage(2)).toBeUndefined();
        expect(source.readPage(1.5)).toBeUndefined();
        expect(source.readPage('0')).toBeUndefined();
        expect(source.readPage()).toBeUndefined();
        expect(calls.length).toBe(warmed);
    });

    it('warms every live page on update and reuses each hit without rendering', () => {
        const texts = ['alpha', 'beta', 'gamma', 'delta'];
        const { renderPage, calls } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });

        source.update({ plan: makePlan(texts), epoch: 0 });
        expect(calls.map((call) => call.text)).toEqual(texts);

        const first = source.readPage(0);
        expect(source.readPage(0)).toBe(first);
        expect(source.readPage(0).dataUrl).toBe(first.dataUrl);
        expect(source.readPage(0).text).toBe(first.text);
        expect(calls.length).toBe(texts.length);
        expect(source.size()).toBe(texts.length);
    });

    it('keeps pixels when the plan repeats and re-renders on geometry change, ignoring billing extras', () => {
        const texts = ['page zero', 'page one'];
        const shape = resolveMicroficheShape(GEMINI_KNOBS);
        const { renderPage, calls } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });

        source.update({ plan: makePlan(texts, shape), epoch: 0 });
        const first = source.readPage(0);

        source.update({
            plan: makePlan(texts, { ...shape, frameTokenEstimate: 999, imageBudget: 5 }),
            epoch: 0,
        });
        expect(source.readPage(0)).toBe(first);
        expect(calls.length).toBe(texts.length);

        source.update({ plan: makePlan(texts, shape), epoch: 0 });
        expect(source.readPage(0)).toBe(first);
        expect(calls.length).toBe(texts.length);

        source.update({
            plan: makePlan(texts, { ...shape, variant: 'sent' }),
            epoch: 0,
        });
        const reshaped = source.readPage(0);
        expect(reshaped).not.toBe(first);
        expect(reshaped.text).toBe('page zero');
        expect(calls.length).toBe(texts.length * 2);
        expect(calls[texts.length].shape.variant).toBe('sent');
    });

    it('reuses the sealed page list when the plan changes inside one epoch', () => {
        const { renderPage, calls } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });

        source.update({ plan: makePlan(['alpha', 'beta']), epoch: 0 });
        expect(calls.map((call) => call.text)).toEqual(['alpha', 'beta']);

        source.update({
            plan: makePlan(['changed alpha', 'changed beta']),
            epoch: 0,
        });

        expect(calls.map((call) => call.text)).toEqual(['alpha', 'beta']);
        expect(source.readPage(0).text).toBe('alpha');
        expect(source.readPage(1).text).toBe('beta');
        expect(source.size()).toBe(2);
    });

    it('reseals the raw span after epoch drift', () => {
        const { renderPage, calls } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });

        source.update({ plan: makePlan(['alpha', 'beta']), epoch: 0 });
        source.update({ plan: makePlan(['new alpha', 'new beta']), epoch: 1 });

        expect(calls.map((call) => call.text)).toEqual(['alpha', 'beta', 'new alpha', 'new beta']);
        expect(source.readPage(0).text).toBe('new alpha');
        expect(source.readPage(1).text).toBe('new beta');
    });

    it('drops every page on epoch drift even when plan and shape match', () => {
        const texts = ['epoch page', 'epoch page two'];
        const { renderPage, calls } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });
        const plan = makePlan(texts);

        source.update({ plan, epoch: 0 });
        const first = source.readPage(0);
        expect(calls.length).toBe(texts.length);

        source.update({ plan, epoch: 1 });
        expect(calls.length).toBe(texts.length * 2);

        const drifted = source.readPage(0);
        expect(drifted).not.toBe(first);
        expect(drifted).toEqual(first);
        expect(source.size()).toBe(texts.length);
    });

    it('bounds reads and cache entries at the sealed page count', () => {
        const { renderPage } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });

        source.update({
            plan: makePlan(['one', 'two', 'three']),
            epoch: 0,
        });
        expect(source.size()).toBe(3);

        source.update({ plan: makePlan(['one', 'two']), epoch: 1 });
        expect(source.size()).toBe(2);
        expect(source.readPage(2)).toBeUndefined();
        expect(source.readPage(0).text).toBe('one');
    });

    it('keeps the sealed page set when updates repeat at a fixed cap', () => {
        const texts = ['alpha', 'beta', 'gamma'];
        const { renderPage, calls } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });
        const plan = makePlan(texts);

        source.update({ plan, epoch: 0 });
        expect(source.size()).toBe(3);

        source.update({ plan, epoch: 0 });
        expect(calls.length).toBe(texts.length);
        expect(source.size()).toBe(3);
        expect(source.readPage(0).text).toBe('alpha');
        expect(source.readPage(1).text).toBe('beta');
        expect(source.readPage(2).text).toBe('gamma');
    });

    it('serves a plan built by buildMicrofichePlan exactly', () => {
        const snippets = [
            'aaa bbb ccc ddd eee fff ggg hhh',
            'iii jjj kkk lll mmm nnn ooo ppp',
            'qqq rrr sss ttt uuu vvv www xxx',
            'yyy zzz aaa bbb ccc ddd eee fff',
            'ggg hhh iii jjj kkk lll mmm nnn',
            'ooo ppp qqq rrr sss ttt uuu vvv',
            'www xxx yyy zzz aaa bbb ccc ddd',
            'eee fff ggg hhh iii jjj kkk lll',
        ];
        const plan = buildMicrofichePlan(
            snippets,
            {
                ...GEMINI_KNOBS,
                microficheKeepRaw: 0,
                microficheImageCap: 8,
                microficheGeometry: 'gemini',
                microficheFrameSize: 64,
            },
            {},
        );
        const { renderPage, calls } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });

        source.update({ plan, epoch: 0 });

        expect(plan.imageTexts.length).toBeGreaterThan(1);
        expect(calls.map((call) => call.text)).toEqual(plan.imageTexts);
        for (let index = 0; index < plan.imageTexts.length; index += 1) {
            expect(source.readPage(index).text).toBe(plan.imageTexts[index]);
        }
        expect(source.readPage(plan.imageTexts.length)).toBeUndefined();
        expect(source.size()).toBe(plan.imageTexts.length);
    });

    it('renders through an injected canvas factory when no renderer is supplied', () => {
        const factory = makeFakeFactory();
        const source = createMicrofichePageSource({ canvasFactory: factory.canvasFactory });

        source.update({ plan: makePlan(['canvas one', 'canvas two']), epoch: 0 });

        expect(source.readPage(0).text).toBe('canvas one');
        expect(source.readPage(1).text).toBe('canvas two');
        expect(factory.canvases.length).toBe(2);
        expect(source.size()).toBe(2);
    });

    it('returns undefined for every index without a renderer', () => {
        const source = createMicrofichePageSource();
        source.update({ plan: makePlan(['one', 'two']), epoch: 0 });
        expect(source.readPage(0)).toBeUndefined();
        expect(source.size()).toBe(0);
    });
});

describe('memory injection writer render cache', () => {
    it('expands the send-time chat from the warmed writer pages', () => {
        const setExtensionPrompt = vi.fn();
        installMicroficheContext({ setExtensionPrompt });
        const factory = makeFakeFactory();
        const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });
        writer.update();
        const page = writer.resolveMicrofichePage(0);
        expect(page).toBeDefined();

        const chat = [{ role: 'system', content: `memory ${formatMicroficheMarker(0)} tail` }];
        onChatCompletionPromptReady({ chat }, undefined, {
            resolveMicrofichePage: writer.resolveMicrofichePage,
        });

        expect(chat[0].content).toContainEqual({
            type: 'image_url',
            image_url: { url: page.dataUrl },
        });
        expect(chat[0].content).toContainEqual({ type: 'text', text: page.text });
    });

    it('serves only the split page count even when the image cap is higher', () => {
        const setExtensionPrompt = vi.fn();
        installMicroficheContext({
            setExtensionPrompt,
            settings: { ...MICROFICHE_SETTINGS, microficheImageCap: 8 },
        });
        const factory = makeFakeFactory();
        const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

        writer.update();
        const pages = readAllPages(writer);
        expect(pages.length).toBeGreaterThan(0);
        expect(pages.length).toBeLessThan(8);
        expect(writer.resolveMicrofichePage(pages.length)).toBeUndefined();
    });

    it('reuses pages and skips the slot write when memory is unchanged', () => {
        const setExtensionPrompt = vi.fn();
        installMicroficheContext({ setExtensionPrompt });
        const factory = makeFakeFactory();
        const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

        writer.update();
        const pages = readAllPages(writer);
        expect(pages.length).toBeGreaterThan(1);
        expect(factory.canvases.length).toBe(pages.length);
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);

        writer.update();
        expect(factory.canvases.length).toBe(pages.length);
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);

        const again = readAllPages(writer);
        expect(again.map((page) => page.dataUrl)).toEqual(pages.map((page) => page.dataUrl));
        expect(again.map((page) => page.text)).toEqual(pages.map((page) => page.text));
        expect(again.map((_, index) => formatMicroficheMarker(index))).toEqual(
            pages.map((_, index) => formatMicroficheMarker(index)),
        );
    });

    it('re-renders on memory edit and never shows stale pages', () => {
        const setExtensionPrompt = vi.fn();
        installMicroficheContext({ setExtensionPrompt });
        const factory = makeFakeFactory();
        const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

        writer.update();
        const before = readAllPages(writer);
        const renders = factory.canvases.length;
        expect(renders).toBeGreaterThan(0);

        const store = getChatStore();
        store.layers[0][0].text += ' brand new detail';
        bumpSummaryStoreMutationEpoch(store);
        writer.update();

        expect(factory.canvases.length).toBeGreaterThan(renders);
        expect(setExtensionPrompt).toHaveBeenCalledTimes(2);
        const after = readAllPages(writer);
        expect(after[0].text).toContain('brand new detail');
        expect(after[0].text).not.toBe(before[0].text);
    });

    it('clears sealed pages on a chat switch that repeats the epoch', () => {
        vi.useFakeTimers();
        try {
            const setExtensionPrompt = vi.fn();
            installMicroficheContext({ setExtensionPrompt });
            const factory = makeFakeFactory();
            const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

            writer.update();
            const firstChatPages = readAllPages(writer);
            expect(firstChatPages.length).toBeGreaterThan(0);
            expect(getSummaryStoreMutationEpoch(getChatStore())).toBe(0);

            // A new chat starts its own epoch at zero, so the switch repeats
            // the epoch the first chat already sealed. The chat-switch reset
            // is the only signal that those pixels belong to another chat.
            installMicroficheContext({
                setExtensionPrompt,
                layers: [
                    [
                        {
                            text: 'Chat B ' + 'replacement memory words '.repeat(80),
                            sourceMessageIds: ['chat-b-message'],
                        },
                    ],
                ],
            });
            expect(getSummaryStoreMutationEpoch(getChatStore())).toBe(0);

            onChatChanged({
                gate: { heal: vi.fn(async () => {}) },
                queue: { isRequestLive: () => false },
                resetMicrofichePages: writer.resetMicrofichePages,
            });
            writer.update();

            const secondChatPages = readAllPages(writer);
            expect(secondChatPages[0].text).toContain('Chat B');
            expect(secondChatPages[0].text).not.toBe(firstChatPages[0].text);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
        }
    });

    it('drops pages on epoch drift while keeping the text slot untouched', () => {
        const setExtensionPrompt = vi.fn();
        installMicroficheContext({ setExtensionPrompt });
        const factory = makeFakeFactory();
        const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

        writer.update();
        const pages = readAllPages(writer);
        const renders = factory.canvases.length;
        expect(renders).toBeGreaterThan(0);
        expect(getSummaryStoreMutationEpoch(getChatStore())).toBe(0);

        bumpSummaryStoreMutationEpoch(getChatStore());
        writer.update();

        expect(factory.canvases.length).toBeGreaterThan(renders);
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        const redone = readAllPages(writer);
        expect(redone.map((page) => page.text)).toEqual(pages.map((page) => page.text));
        expect(redone.map((page) => page.dataUrl).length).toBe(pages.length);
        expect(redone[0]).not.toBe(pages[0]);
    });
});

describe('memory injection writer microfiche markers', () => {
    it('writes one marker per image page when memory images are on', () => {
        const setExtensionPrompt = vi.fn();
        installMicroficheContext({
            setExtensionPrompt,
            settings: { ...MICROFICHE_SETTINGS, microficheMemoryImages: true },
        });
        const factory = makeFakeFactory();
        const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

        writer.update();

        const text = setExtensionPrompt.mock.calls[0][1];
        const pages = readAllPages(writer);
        expect(pages.length).toBeGreaterThan(0);
        expect(extractMicroficheMarkers(text)).toEqual(
            pages.map((_page, index) => ({ pageIndex: index, region: 'memory' })),
        );
        expect(text).not.toContain(pages[0].text);
    });

    it('expands the writer payload into rendered image parts', () => {
        const setExtensionPrompt = vi.fn();
        installMicroficheContext({
            setExtensionPrompt,
            settings: { ...MICROFICHE_SETTINGS, microficheMemoryImages: true },
        });
        const factory = makeFakeFactory();
        const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

        writer.update();

        const chat = [{ role: 'system', content: setExtensionPrompt.mock.calls[0][1] }];
        onChatCompletionPromptReady({ chat }, undefined, {
            resolveMicrofichePage: writer.resolveMicrofichePage,
        });

        const pages = readAllPages(writer);
        const images = chat[0].content.filter((part) => part.type === 'image_url');
        expect(images).toEqual(
            pages.map((page) => ({ type: 'image_url', image_url: { url: page.dataUrl } })),
        );
    });

    it('keeps the pre-change text payload when both image toggles are off', () => {
        const setExtensionPrompt = vi.fn();
        installMicroficheContext({ setExtensionPrompt });
        const factory = makeFakeFactory();
        const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

        writer.update();

        const text = setExtensionPrompt.mock.calls[0][1];
        const expected = buildInjection(getChatStore().layers, getEffectiveSettings()).text;
        expect(text).toBe(expected);
        expect(text).not.toContain(formatMicroficheMarker(0));
    });

    it('leaves memory text alone and appends raw markers when only the frozen raw toggle is on', () => {
        const setExtensionPrompt = vi.fn();
        const chat = makeMessages(24, { mes: 'lorem ipsum dolor sit amet '.repeat(80) });
        installMicroficheContext({
            setExtensionPrompt,
            chat,
            settings: { ...MICROFICHE_SETTINGS, microficheFrozenRawImages: true },
        });
        const factory = makeFakeFactory();
        const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

        writer.update();

        const text = setExtensionPrompt.mock.calls[0][1];
        const expected = buildInjection(getChatStore().layers, getEffectiveSettings()).text;
        expect(text.startsWith(expected)).toBe(true);
        const markers = extractMicroficheMarkers(text);
        expect(markers.some((marker) => marker.region === 'memory')).toBe(false);
        const rawMarkers = markers.filter((marker) => marker.region === 'raw');
        expect(rawMarkers.length).toBeGreaterThan(0);
        expect(rawMarkers.map((marker) => marker.pageIndex)).toEqual(
            rawMarkers.map((_marker, index) => index),
        );
        expect(text).toContain(formatMicroficheRawMarker(0));

        const rawPages = [];
        for (let index = 0; index < rawMarkers.length; index += 1) {
            const page = writer.resolveMicrofichePage(index, 'raw');
            if (!page) {
                break;
            }
            rawPages.push(page);
        }
        expect(rawPages.length).toBe(rawMarkers.length);
    });

    it('renders frozen raw images on empty layers with both toggles on', () => {
        const setExtensionPrompt = vi.fn();
        const chat = makeMessages(24, { mes: 'lorem ipsum dolor sit amet '.repeat(80) });
        installMicroficheContext({
            setExtensionPrompt,
            chat,
            layers: [],
            settings: {
                ...MICROFICHE_SETTINGS,
                microficheMemoryImages: true,
                microficheFrozenRawImages: true,
            },
        });
        const factory = makeFakeFactory();
        const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

        writer.update();

        const text = setExtensionPrompt.mock.calls[0][1];
        const expanded = expandCapturedChat(
            [{ role: 'system', content: text }],
            writer.resolveMicrofichePage,
        );
        expect(expanded.resolvedMarkers).toBeGreaterThan(0);
        expect(expanded.unresolvedMarkers).toEqual([]);
        const view = describeDryRunPrompt({
            chat: expanded.chat,
            epoch: getSummaryStoreMutationEpoch(getChatStore()),
            settings: getEffectiveSettings(),
            resolvedMarkers: expanded.resolvedMarkers,
            unresolvedMarkers: expanded.unresolvedMarkers,
            promptManagerReady: true,
        });
        expect(view.imageParts).toBe(expanded.resolvedMarkers);
        expect(view.imageParts).toBeGreaterThan(0);
    });

    it('reseals a growing memory-less chat into raw images that fit the bucket', () => {
        const setExtensionPrompt = vi.fn();
        const chat = makeMessages(2, { mes: 'seed '.repeat(40) });
        installMicroficheContext({
            setExtensionPrompt,
            chat,
            layers: [],
            settings: {
                ...MICROFICHE_SETTINGS,
                microficheMemoryImages: true,
                microficheFrozenRawImages: true,
                microficheImageCap: 5,
                verbatimTokenBudget: 20000,
                queuedTokenBudget: 16000,
            },
        });
        const factory = makeFakeFactory();
        const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

        writer.update();
        expect(readAllRawPages(writer)).toHaveLength(0);

        // The first seal froze nothing; growing to the 36k fixture must
        // re-seal instead of leaving the chat as text for the epoch.
        chat.push(
            ...makeMessages(36, (index) => ({
                isUser: index % 2 === 0,
                mes: 'grow '.repeat(800),
            })),
        );
        writer.update();

        const rawPages = readAllRawPages(writer);
        expect(rawPages.length).toBeGreaterThan(0);
        const text = setExtensionPrompt.mock.calls.at(-1)[1];
        const markers = extractMicroficheMarkers(text);
        expect(markers.filter((marker) => marker.region === 'memory')).toHaveLength(0);
        const rawMarkers = markers.filter((marker) => marker.region === 'raw');
        expect(rawMarkers).toHaveLength(rawPages.length);
        expect(rawMarkers.map((marker) => marker.pageIndex)).toEqual(
            rawPages.map((_page, index) => index),
        );
        expect(getChatStore().layers).toHaveLength(0);
    });

    it('keeps the raw seal frozen once memory exists', () => {
        const setExtensionPrompt = vi.fn();
        const chat = makeMessages(24, { mes: 'lorem ipsum dolor sit amet '.repeat(80) });
        installMicroficheContext({
            setExtensionPrompt,
            chat,
            settings: { ...MICROFICHE_SETTINGS, microficheFrozenRawImages: true },
        });
        const factory = makeFakeFactory();
        const writer = makeMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

        writer.update();
        const sealedTexts = readAllRawPages(writer).map((page) => page.text);
        expect(sealedTexts.length).toBeGreaterThan(0);

        chat.push(...makeMessages(4, { mes: 'tail '.repeat(200) }));
        writer.update();

        expect(readAllRawPages(writer).map((page) => page.text)).toEqual(sealedTexts);
        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
    });
});
