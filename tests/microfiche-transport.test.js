import { beforeEach, describe, expect, it } from 'vitest';

import { onChatCompletionPromptReady } from '../src/entry/events.js';
import {
    clearMicroficheStubPages,
    expandMicroficheContent,
    expandMicrofichePromptChat,
    extractMicroficheMarkers,
    extractMicrofichePageIndices,
    formatMicroficheMarker,
    formatMicroficheRawMarker,
    registerMicroficheStubPage,
    resolveMicroficheStubPage,
} from '../src/core/microfiche-transport.js';

const { logger } = globalThis.summaryceptionFoundationMocks;

const STUB_ZERO = { dataUrl: 'data:image/png;base64,stub-page-zero', text: 'stub page zero text' };
const STUB_ONE = { dataUrl: 'data:image/png;base64,stub-page-one', text: 'stub page one text' };

function registerStubPages() {
    registerMicroficheStubPage(0, STUB_ZERO);
    registerMicroficheStubPage(1, STUB_ONE);
}

beforeEach(() => {
    clearMicroficheStubPages();
    logger.trace.mockClear();
});

describe('microfiche marker codec', () => {
    it('formats a single-line namespaced marker per page', () => {
        const marker = formatMicroficheMarker(2);
        expect(marker).toBe('[summaryception-microfiche page=2]');
        expect(marker).not.toContain('\n');
    });

    it('rejects negative and non-integer page indexes', () => {
        expect(() => formatMicroficheMarker(-1)).toThrow();
        expect(() => formatMicroficheMarker(1.5)).toThrow();
    });

    it('formats a region-tagged raw marker without colliding with memory page zero', () => {
        const rawMarker = formatMicroficheRawMarker(0);
        expect(rawMarker).toBe('[summaryception-microfiche page=0:raw]');
        expect(rawMarker).not.toBe(formatMicroficheMarker(0));
        expect(extractMicroficheMarkers(rawMarker)).toEqual([{ pageIndex: 0, region: 'raw' }]);
        expect(extractMicrofichePageIndices(rawMarker)).toEqual([0]);
    });

    it('rejects negative and non-integer raw page indexes', () => {
        expect(() => formatMicroficheRawMarker(-1)).toThrow();
        expect(() => formatMicroficheRawMarker(1.5)).toThrow();
    });

    it('round-trips page indexes through extract', () => {
        const text = `before ${formatMicroficheMarker(0)} mid ${formatMicroficheMarker(12)} after`;
        expect(extractMicrofichePageIndices(text)).toEqual([0, 12]);
    });

    it('ignores narrative, declined, and prose lookalikes', () => {
        const text =
            '<narrative>story</narrative> <declined>busy</declined> [NARRATIVE] page=3 ' +
            '[summaryception-microfiche page=] [summaryception-microfiche]';
        expect(extractMicrofichePageIndices(text)).toEqual([]);
    });

    it('returns no indexes for non-string input', () => {
        expect(extractMicrofichePageIndices(null)).toEqual([]);
        expect(extractMicrofichePageIndices(42)).toEqual([]);
    });
});

describe('microfiche stub registry', () => {
    it('resolves registered stub pages', () => {
        registerStubPages();
        expect(resolveMicroficheStubPage(0)).toEqual(STUB_ZERO);
        expect(resolveMicroficheStubPage(1)).toEqual(STUB_ONE);
    });

    it('keeps raw stubs apart from memory stubs at the same index', () => {
        registerMicroficheStubPage(0, STUB_ZERO);
        registerMicroficheStubPage(0, STUB_ONE, 'raw');
        expect(resolveMicroficheStubPage(0)).toEqual(STUB_ZERO);
        expect(resolveMicroficheStubPage(0, 'raw')).toEqual(STUB_ONE);
    });

    it('returns undefined for unknown pages', () => {
        registerStubPages();
        expect(resolveMicroficheStubPage(7)).toBeUndefined();
    });

    it('forgets pages on clear', () => {
        registerStubPages();
        clearMicroficheStubPages();
        expect(resolveMicroficheStubPage(0)).toBeUndefined();
    });
});

describe('expandMicroficheContent', () => {
    it('leaves marker-free strings untouched', () => {
        const result = expandMicroficheContent('plain memory');
        expect(result.swapped).toBe(0);
        expect(result.content).toBe('plain memory');
    });

    it('leaves unknown markers as plain text', () => {
        const marker = formatMicroficheMarker(7);
        const result = expandMicroficheContent(`a ${marker} b`);
        expect(result.swapped).toBe(0);
        expect(result.content).toBe(`a ${marker} b`);
    });

    it('swaps each registered marker for text plus image parts in order', () => {
        registerStubPages();
        const content = `before ${formatMicroficheMarker(0)} between ${formatMicroficheMarker(1)} after`;
        const result = expandMicroficheContent(content);
        expect(result.swapped).toBe(2);
        const images = result.content.filter((part) => part.type === 'image_url');
        expect(images.map((part) => part.image_url.url)).toEqual([
            STUB_ZERO.dataUrl,
            STUB_ONE.dataUrl,
        ]);
        const text = result.content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('');
        expect(text).toBe(`before ${STUB_ZERO.text} between ${STUB_ONE.text} after`);
    });

    it('pins the OpenAI image part shape as the stub contract', () => {
        registerStubPages();
        const result = expandMicroficheContent(formatMicroficheMarker(0));
        expect(result.swapped).toBe(1);
        expect(result.content).toEqual([
            { type: 'text', text: STUB_ZERO.text },
            { type: 'image_url', image_url: { url: STUB_ZERO.dataUrl } },
        ]);
    });

    it('reads raw markers with the raw region and memory markers with one argument', () => {
        const calls = [];
        const resolvePage = (pageIndex, region) => {
            calls.push({ pageIndex, region });
            return region === 'raw' ? STUB_ONE : STUB_ZERO;
        };
        const content = `${formatMicroficheMarker(0)} ${formatMicroficheRawMarker(0)}`;
        const result = expandMicroficheContent(content, resolvePage);
        expect(result.swapped).toBe(2);
        expect(calls).toEqual([
            { pageIndex: 0, region: undefined },
            { pageIndex: 0, region: 'raw' },
        ]);
        const urls = result.content
            .filter((part) => part.type === 'image_url')
            .map((part) => part.image_url.url);
        expect(urls).toEqual([STUB_ZERO.dataUrl, STUB_ONE.dataUrl]);
    });

    it('expands text entries inside array content without touching other parts', () => {
        registerStubPages();
        const kept = { type: 'image_url', image_url: { url: 'data:keep' } };
        const content = [{ type: 'text', text: `a ${formatMicroficheMarker(1)}` }, kept];
        const result = expandMicroficheContent(content);
        expect(result.swapped).toBe(1);
        expect(result.content).toEqual([
            { type: 'text', text: 'a ' },
            { type: 'text', text: STUB_ONE.text },
            { type: 'image_url', image_url: { url: STUB_ONE.dataUrl } },
            kept,
        ]);
        expect(content[0]).toEqual({ type: 'text', text: `a ${formatMicroficheMarker(1)}` });
    });

    it('leaves non-string and non-array content untouched', () => {
        expect(expandMicroficheContent(42)).toEqual({ content: 42, swapped: 0 });
        expect(expandMicroficheContent(null)).toEqual({ content: null, swapped: 0 });
    });
});

describe('expandMicrofichePromptChat', () => {
    it.each([
        ['null', null],
        ['number', 42],
        ['object without chat', {}],
        ['array with a non-plain element', [{ role: 'user', content: 'a' }, 5]],
    ])('returns 0 for an unusable payload (%s)', (_label, payload) => {
        const snapshot = JSON.stringify(payload);
        expect(expandMicrofichePromptChat(payload)).toBe(0);
        expect(JSON.stringify(payload)).toBe(snapshot);
    });

    it('returns 0 and keeps string content identical without markers', () => {
        const chat = [{ role: 'user', content: 'hello' }];
        expect(expandMicrofichePromptChat(chat)).toBe(0);
        expect(chat[0].content).toBe('hello');
    });

    it('expands marker-bearing strings in place and counts swaps', () => {
        registerStubPages();
        const chat = [
            { role: 'system', content: `mem ${formatMicroficheMarker(0)} tail` },
            { role: 'user', content: `ask ${formatMicroficheMarker(1)} now` },
        ];
        expect(expandMicrofichePromptChat(chat)).toBe(2);
        expect(chat[0].content.filter((part) => part.type === 'image_url')).toEqual([
            { type: 'image_url', image_url: { url: STUB_ZERO.dataUrl } },
        ]);
        expect(chat[1].content.filter((part) => part.type === 'image_url')).toEqual([
            { type: 'image_url', image_url: { url: STUB_ONE.dataUrl } },
        ]);
        expect(chat[0].role).toBe('system');
    });

    it('keeps unknown markers as text and counts only resolved swaps', () => {
        registerStubPages();
        const unknown = formatMicroficheMarker(9);
        const chat = [{ role: 'system', content: `${formatMicroficheMarker(0)} ${unknown}` }];
        expect(expandMicrofichePromptChat(chat)).toBe(1);
        const text = chat[0].content
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('');
        expect(text).toContain(unknown);
        expect(chat[0].content.filter((part) => part.type === 'image_url')).toHaveLength(1);
    });

    it('leaves non-string content alone', () => {
        const chat = [{ role: 'user', content: 42 }];
        expect(expandMicrofichePromptChat(chat)).toBe(0);
        expect(chat[0].content).toBe(42);
    });
});

describe('prompt slot stays text-only', () => {
    it('carries markers as a plain string through setExtensionPrompt-shaped payloads', () => {
        const marker = formatMicroficheMarker(0);
        const payload = {
            name: 'summaryception',
            text: `memory ${marker} tail`,
            position: 'in-prompt',
        };
        expect(typeof payload.text).toBe('string');
        expect(payload.text).toContain(marker);
    });

    it('keeps binary out of a writer dedupe-shaped key', () => {
        registerStubPages();
        const marker = formatMicroficheMarker(0);
        const text = `memory ${marker} tail`;
        const key = JSON.stringify({ text, options: { position: 'in-prompt' } });
        expect(key).toContain(marker);
        expect(key).not.toContain(STUB_ZERO.dataUrl);
        expect(typeof JSON.parse(key).text).toBe('string');
    });
});

describe('stub pages round-trip end to end', () => {
    it('expands two stub pages with surrounding text preserved', () => {
        registerStubPages();
        const chat = [
            {
                role: 'system',
                content: `recall ${formatMicroficheMarker(0)} mid ${formatMicroficheMarker(1)} end`,
            },
        ];
        expect(expandMicrofichePromptChat(chat)).toBe(2);
        const parts = chat[0].content;
        const urls = parts.filter((part) => part.type === 'image_url');
        expect(urls.map((part) => part.image_url.url)).toEqual([
            STUB_ZERO.dataUrl,
            STUB_ONE.dataUrl,
        ]);
        const text = parts
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('');
        expect(text).toBe(`recall ${STUB_ZERO.text} mid ${STUB_ONE.text} end`);
    });
});

describe('onChatCompletionPromptReady microfiche transport', () => {
    it('expands marker chat on real prompt events and keeps prefix bookkeeping', () => {
        registerStubPages();
        const chat = [{ role: 'system', content: `mem ${formatMicroficheMarker(0)} tail` }];
        onChatCompletionPromptReady({ chat });
        expect(chat[0].content).toEqual([
            { type: 'text', text: 'mem ' },
            { type: 'text', text: STUB_ZERO.text },
            { type: 'image_url', image_url: { url: STUB_ZERO.dataUrl } },
            { type: 'text', text: ' tail' },
        ]);
        expect(logger.trace).toHaveBeenCalledWith('Prompt prefix baseline: 1 blocks');
    });

    it('leaves dry-run payloads untouched in either event signature', () => {
        const first = [{ role: 'system', content: `dry ${formatMicroficheMarker(0)}` }];
        const second = [{ role: 'system', content: `dry ${formatMicroficheMarker(0)}` }];
        onChatCompletionPromptReady({ chat: first }, true);
        onChatCompletionPromptReady({ chat: second, dryRun: true });
        expect(first[0].content).toBe(`dry ${formatMicroficheMarker(0)}`);
        expect(second[0].content).toBe(`dry ${formatMicroficheMarker(0)}`);
    });

    it('never throws on unusable chat payloads', () => {
        expect(() => onChatCompletionPromptReady(null)).not.toThrow();
        expect(() => onChatCompletionPromptReady({})).not.toThrow();
        expect(() => onChatCompletionPromptReady({ chat: 'nope' })).not.toThrow();
    });
});
