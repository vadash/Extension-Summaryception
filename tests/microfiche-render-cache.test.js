import { describe, expect, it, vi } from 'vitest';

import {
    getSummaryStoreMutationEpoch,
    bumpSummaryStoreMutationEpoch,
    getChatStore,
} from '../src/foundation/chat-store.js';
import { MEMORY_MODES } from '../src/foundation/constants.js';
import { resolveMicroficheShape } from '../src/core/microfiche-paginate.js';
import { hashMicroficheShape } from '../src/core/microfiche-pages.js';
import {
    createMicroficheRenderCache,
    hashMicroficheText,
} from '../src/core/microfiche-render-cache.js';
import { formatMicroficheMarker } from '../src/core/microfiche-transport.js';
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

describe('microfiche render cache keys', () => {
    it('hashes built injection text deterministically', () => {
        expect(hashMicroficheText('same text')).toBe(hashMicroficheText('same text'));
        expect(hashMicroficheText('one')).not.toBe(hashMicroficheText('two'));
        expect(hashMicroficheShape(resolveMicroficheShape(GEMINI_KNOBS))).toBe(
            hashMicroficheShape(resolveMicroficheShape(GEMINI_KNOBS)),
        );
    });

    it('misses on text or geometry change but ignores billing extras', () => {
        const cache = createMicroficheRenderCache();
        const shape = resolveMicroficheShape(GEMINI_KNOBS);
        let renders = 0;
        const render = (label) => () => {
            renders += 1;
            return { dataUrl: `data:fake:${label}`, text: label };
        };
        const base = { epoch: 0, text: 'built injection text', shape, effectiveCap: 4 };

        const first = cache.getPage({ ...base, pageIndex: 0, render: render('p0') });
        expect(renders).toBe(1);

        const billed = cache.getPage({
            ...base,
            shape: { ...shape, frameTokenEstimate: 999, imageBudget: 5 },
            pageIndex: 0,
            render: render('p0-billed'),
        });
        expect(billed).toBe(first);
        expect(renders).toBe(1);

        const reshaped = cache.getPage({
            ...base,
            shape: { ...shape, variant: 'sent' },
            pageIndex: 0,
            render: render('p0-sent'),
        });
        expect(reshaped).not.toBe(first);
        expect(renders).toBe(2);

        const reworded = cache.getPage({
            ...base,
            text: 'edited injection text',
            pageIndex: 0,
            render: render('p0-edited'),
        });
        expect(reworded).not.toBe(first);
        expect(renders).toBe(3);
    });

    it('drops every page on epoch drift even when text and shape match', () => {
        const cache = createMicroficheRenderCache();
        const shape = resolveMicroficheShape(GEMINI_KNOBS);
        let renders = 0;
        const render = () => {
            renders += 1;
            return { dataUrl: 'data:fake:page', text: 'page text' };
        };
        const base = { epoch: 0, text: 'built injection text', shape, effectiveCap: 4 };

        const first = cache.getPage({ ...base, pageIndex: 0, render });
        expect(cache.getPage({ ...base, pageIndex: 0, render })).toBe(first);
        expect(renders).toBe(1);

        const drifted = cache.getPage({ ...base, epoch: 1, pageIndex: 0, render });
        expect(renders).toBe(2);
        expect(drifted).not.toBe(first);
        expect(drifted).toEqual(first);
        expect(cache.size()).toBe(1);
    });

    it('returns byte-identical pages on a hit', () => {
        const cache = createMicroficheRenderCache();
        const shape = resolveMicroficheShape(GEMINI_KNOBS);
        const render = () => ({ dataUrl: 'data:fake:bytes', text: 'page bytes' });
        const base = { epoch: 0, text: 'built injection text', shape, effectiveCap: 4 };

        const first = cache.getPage({ ...base, pageIndex: 0, render });
        const second = cache.getPage({ ...base, pageIndex: 0, render });
        expect(second).toBe(first);
        expect(second.dataUrl).toBe(first.dataUrl);
        expect(second.text).toBe(first.text);
    });

    it('ignores indexes outside the live cap without rendering', () => {
        const cache = createMicroficheRenderCache();
        const shape = resolveMicroficheShape(GEMINI_KNOBS);
        let renders = 0;
        const render = () => {
            renders += 1;
            return { dataUrl: 'data:fake:page', text: 'page text' };
        };

        expect(
            cache.getPage({ epoch: 0, text: 't', shape, pageIndex: 2, effectiveCap: 2, render }),
        ).toBeUndefined();
        expect(renders).toBe(0);
    });
});

describe('microfiche render cache LRU', () => {
    it('evicts the least recently used page past the live cap', () => {
        const cache = createMicroficheRenderCache();
        const shape = resolveMicroficheShape(GEMINI_KNOBS);
        let renders = 0;
        const render = (label) => () => {
            renders += 1;
            return { dataUrl: `data:fake:${label}`, text: label };
        };
        const base = { epoch: 0, text: 'built injection text', shape, effectiveCap: 2 };

        const first = cache.getPage({ ...base, pageIndex: 0, render: render('p0') });
        cache.getPage({ ...base, pageIndex: 1, render: render('p1') });
        expect(renders).toBe(2);
        expect(cache.size()).toBe(2);

        expect(cache.getPage({ ...base, pageIndex: 0, render: render('p0-again') })).toBe(first);
        expect(renders).toBe(2);

        const grown = { ...base, effectiveCap: 3 };
        cache.getPage({ ...grown, pageIndex: 2, render: render('p2') });
        expect(renders).toBe(3);
        expect(cache.size()).toBe(3);
        expect(cache.getPage({ ...grown, pageIndex: 0, render: render('p0-live') })).toBe(first);
        expect(
            cache.getPage({ ...grown, pageIndex: 1, render: render('p1-live') }),
        ).not.toBeUndefined();
        expect(renders).toBe(3);

        // Growing once more and paging a fourth entry forces a true LRU
        // eviction of the stalest entry (page 2, untouched since its render).
        const wider = { ...base, effectiveCap: 4 };
        cache.getPage({ ...wider, pageIndex: 3, render: render('p3') });
        expect(renders).toBe(4);
        expect(cache.size()).toBe(4);
        cache.getPage({ ...wider, pageIndex: 0, render: render('p0-newest') });
        cache.getPage({ ...wider, pageIndex: 1, render: render('p1-newest') });
        cache.getPage({ ...wider, pageIndex: 3, render: render('p3-newest') });
        expect(renders).toBe(4);
        // The capped read below drops the stalest entry and re-renders it.
        const overflow = { ...base, effectiveCap: 3 };
        expect(
            cache.getPage({ ...overflow, pageIndex: 2, render: render('p2') }),
        ).not.toBeUndefined();
        expect(renders).toBe(4);
        expect(cache.size()).toBe(3);
    });

    it('trims to a shrunken live cap', () => {
        const cache = createMicroficheRenderCache();
        const shape = resolveMicroficheShape(GEMINI_KNOBS);
        const render = (label) => () => ({ dataUrl: `data:fake:${label}`, text: label });
        const base = { epoch: 0, text: 'built injection text', shape, effectiveCap: 3 };

        cache.getPage({ ...base, pageIndex: 0, render: render('p0') });
        cache.getPage({ ...base, pageIndex: 1, render: render('p1') });
        cache.getPage({ ...base, pageIndex: 2, render: render('p2') });
        expect(cache.size()).toBe(3);

        const shrunk = { ...base, effectiveCap: 1 };
        const kept = cache.getPage({ ...shrunk, pageIndex: 0, render: render('p0') });
        expect(kept).not.toBeUndefined();
        expect(cache.size()).toBe(1);
        expect(cache.getPage({ ...shrunk, pageIndex: 2, render: render('p2') })).toBeUndefined();
    });
});

describe('memory injection writer render cache', () => {
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
