import { describe, expect, it, vi } from 'vitest';

import {
    getSummaryStoreMutationEpoch,
    bumpSummaryStoreMutationEpoch,
    getChatStore,
} from '../src/foundation/chat-store.js';
import { MEMORY_MODES } from '../src/foundation/constants.js';
import { resolveMicroficheShape } from '../src/core/microfiche-paginate.js';
import { buildMicrofichePlan } from '../src/core/microfiche-policy.js';
import { createMicrofichePageSource } from '../src/core/microfiche-pages.js';
import { formatMicroficheMarker } from '../src/core/microfiche-transport.js';
import { onChatCompletionPromptReady } from '../src/entry/events.js';
import { createMemoryInjectionWriter } from '../src/features/injection.js';
import { installSummaryContext, makeMessages, makeSummaryStore } from './test-helpers.js';

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

function installMicroficheContext({ layers, setExtensionPrompt, settings } = {}) {
    const chat = makeMessages(24);
    const resolvedLayers = layers ?? [
        [
            {
                text: `Snippet 0 ` + 'lorem ipsum dolor sit amet '.repeat(40),
                sourceMessageIds: [chat[0].sc_id],
            },
            {
                text: `Snippet 1 ` + 'lorem ipsum dolor sit amet '.repeat(40),
                sourceMessageIds: [chat[1].sc_id],
            },
        ],
        [
            {
                text: `Snippet 2 ` + 'lorem ipsum dolor sit amet '.repeat(40),
                sourceMessageIds: [chat[2].sc_id],
            },
            {
                text: `Snippet 3 ` + 'lorem ipsum dolor sit amet '.repeat(40),
                sourceMessageIds: [chat[3].sc_id],
            },
        ],
    ];
    installSummaryContext({
        chat,
        metadata: { summaryception: makeSummaryStore({ layers: resolvedLayers }) },
        settings: settings ?? MICROFICHE_SETTINGS,
        setExtensionPrompt,
    });
    return chat;
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

describe('microfiche page source', () => {
    it('serves each live page by index in plan order', () => {
        const texts = ['first page', 'second page', 'third page'];
        const { renderPage } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });

        source.update({ plan: makePlan(texts), text: 'built injection text', epoch: 0 });

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

        source.update({ plan: makePlan(['one', 'two']), text: 'built injection text', epoch: 0 });
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

        source.update({ plan: makePlan(texts), text: 'built injection text', epoch: 0 });
        expect(calls.map((call) => call.text)).toEqual(texts);

        const first = source.readPage(0);
        expect(source.readPage(0)).toBe(first);
        expect(source.readPage(0).dataUrl).toBe(first.dataUrl);
        expect(source.readPage(0).text).toBe(first.text);
        expect(calls.length).toBe(texts.length);
        expect(source.size()).toBe(texts.length);
    });

    it('keeps pixels on text edits and re-renders on geometry change, ignoring billing extras', () => {
        const texts = ['page zero', 'page one'];
        const shape = resolveMicroficheShape(GEMINI_KNOBS);
        const { renderPage, calls } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });

        source.update({ plan: makePlan(texts, shape), text: 'built injection text', epoch: 0 });
        const first = source.readPage(0);

        source.update({
            plan: makePlan(texts, { ...shape, frameTokenEstimate: 999, imageBudget: 5 }),
            text: 'built injection text',
            epoch: 0,
        });
        expect(source.readPage(0)).toBe(first);
        expect(calls.length).toBe(texts.length);

        source.update({ plan: makePlan(texts, shape), text: 'edited injection text', epoch: 0 });
        expect(source.readPage(0)).toBe(first);
        expect(calls.length).toBe(texts.length);

        source.update({
            plan: makePlan(texts, { ...shape, variant: 'sent' }),
            text: 'edited injection text',
            epoch: 0,
        });
        const reshaped = source.readPage(0);
        expect(reshaped).not.toBe(first);
        expect(reshaped.text).toBe('page zero');
        expect(calls.length).toBe(texts.length * 2);
        expect(calls[texts.length].shape.variant).toBe('sent');
    });

    it('reuses the sealed page list when plan and text change inside one epoch', () => {
        const { renderPage, calls } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });

        source.update({ plan: makePlan(['alpha', 'beta']), text: 'built A', epoch: 0 });
        expect(calls.map((call) => call.text)).toEqual(['alpha', 'beta']);

        source.update({
            plan: makePlan(['changed alpha', 'changed beta']),
            text: 'built B',
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

        source.update({ plan: makePlan(['alpha', 'beta']), text: 'built A', epoch: 0 });
        source.update({ plan: makePlan(['new alpha', 'new beta']), text: 'built B', epoch: 1 });

        expect(calls.map((call) => call.text)).toEqual(['alpha', 'beta', 'new alpha', 'new beta']);
        expect(source.readPage(0).text).toBe('new alpha');
        expect(source.readPage(1).text).toBe('new beta');
    });

    it('drops every page on epoch drift even when text and shape match', () => {
        const texts = ['epoch page', 'epoch page two'];
        const { renderPage, calls } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });
        const plan = makePlan(texts);

        source.update({ plan, text: 'built injection text', epoch: 0 });
        const first = source.readPage(0);
        expect(calls.length).toBe(texts.length);

        source.update({ plan, text: 'built injection text', epoch: 1 });
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
            text: 'built injection text',
            epoch: 0,
        });
        expect(source.size()).toBe(3);

        source.update({ plan: makePlan(['one', 'two']), text: 'built injection text', epoch: 1 });
        expect(source.size()).toBe(2);
        expect(source.readPage(2)).toBeUndefined();
        expect(source.readPage(0).text).toBe('one');
    });

    it('keeps the sealed page set when text changes at a fixed cap', () => {
        const texts = ['alpha', 'beta', 'gamma'];
        const { renderPage, calls } = makeFakeRenderer();
        const source = createMicrofichePageSource({ renderPage });
        const plan = makePlan(texts);

        source.update({ plan, text: 'built A', epoch: 0 });
        expect(source.size()).toBe(3);

        source.update({ plan, text: 'built B', epoch: 0 });
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

        source.update({ plan, text: 'built injection text', epoch: 0 });

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

        source.update({ plan: makePlan(['canvas one', 'canvas two']), text: 'built', epoch: 0 });

        expect(source.readPage(0).text).toBe('canvas one');
        expect(source.readPage(1).text).toBe('canvas two');
        expect(factory.canvases.length).toBe(2);
        expect(source.size()).toBe(2);
    });

    it('returns undefined for every index without a renderer', () => {
        const source = createMicrofichePageSource();
        source.update({ plan: makePlan(['one', 'two']), text: 'built', epoch: 0 });
        expect(source.readPage(0)).toBeUndefined();
        expect(source.size()).toBe(0);
    });
});

describe('memory injection writer render cache', () => {
    it('expands the send-time chat from the warmed writer pages', () => {
        const setExtensionPrompt = vi.fn();
        installMicroficheContext({ setExtensionPrompt });
        const factory = makeFakeFactory();
        const writer = createMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });
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
        const writer = createMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

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
        const writer = createMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

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
        const writer = createMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

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

    it('drops pages on epoch drift while keeping the text slot untouched', () => {
        const setExtensionPrompt = vi.fn();
        installMicroficheContext({ setExtensionPrompt });
        const factory = makeFakeFactory();
        const writer = createMemoryInjectionWriter({ canvasFactory: factory.canvasFactory });

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
