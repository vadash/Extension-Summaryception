import { describe, expect, it, vi } from 'vitest';

import {
    EXTENSION_PROMPT_POSITIONS,
    EXTENSION_PROMPT_ROLES,
    MEMORY_POSITIONS,
    defaultSettings,
} from '../src/foundation/constants.js';
import {
    buildInjection,
    buildMemoryBody,
    buildMemoryInjectionParts,
    measureInjection,
    renderInjectionTemplate,
} from '../src/core/memory-injection.js';
import { buildMicrofichePlan } from '../src/core/microfiche-policy.js';
import {
    formatAnchoredSnippetNarrative,
    formatSnippetAnchor,
} from '../src/core/snippet-metadata.js';
import { countTextTokens } from '../src/core/token-count.js';
import { installSummaryContext, makeMemoryInjectionWriter, makeMessages } from './test-helpers.js';

describe('buildMemoryInjectionParts', () => {
    it('joins per-layer chronology sections with no heading of its own', () => {
        const layers = [
            [{ text: 'The party reached the tavern.' }],
            [{ text: 'The ferry crossed at dawn.' }],
        ];

        const parts = buildMemoryInjectionParts(layers);

        expect(parts.memoryText).toContain('The party reached the tavern.');
        expect(parts.memoryText).toContain('The ferry crossed at dawn.');
        // The injection template legend names the section; the body adds no heading.
        expect(parts.memoryText).toBe(parts.chronologyText);
    });

    it('reports chronology parts tagged by layer index, deepest first', () => {
        const layers = [[{ text: 'First beat.' }], [{ text: 'Second beat.' }]];

        const parts = buildMemoryInjectionParts(layers);

        expect(parts.chronologyParts).toHaveLength(2);
        expect(parts.chronologyParts[0].layerIndex).toBe(1);
        expect(parts.chronologyParts[0].text).toContain('Second beat.');
        expect(parts.chronologyParts[1].layerIndex).toBe(0);
    });

    it('returns empty parts for a missing layer list', () => {
        expect(buildMemoryInjectionParts(undefined)).toEqual({
            chronologyParts: [],
            chronologyText: '',
            memoryText: '',
        });
    });
});

describe('buildInjection', () => {
    it('wraps the memory body in the injection template and tags its parts by layer', () => {
        const layers = [
            [{ text: 'The party reached the tavern.' }],
            [{ text: 'The ferry crossed at dawn.' }],
        ];

        const injection = buildInjection(layers, { injectionTemplate: 'A {{summary}} B' });

        expect(injection.text).not.toContain('{{summary}}');
        expect(injection.text).toContain('A ');
        expect(injection.text).toContain('The party reached the tavern.');
        expect(injection.text).toContain('The ferry crossed at dawn.');
        expect(injection.parts.map((part) => part.layerIndex)).toEqual([1, 0]);
    });

    it('replaces every {{summary}} occurrence in the injection template', () => {
        const layers = [[{ text: 'some memory' }]];
        const injection = buildInjection(layers, {
            injectionTemplate: 'A {{summary}} B {{summary}} C',
        });

        const memoryText = 'some memory';
        const occurrences = injection.text.split(memoryText).length - 1;
        expect(occurrences).toBe(2);
    });

    it('suppresses the template entirely when no memories exist', () => {
        const injection = buildInjection([], { injectionTemplate: 'Memory:\n{{summary}}' });

        expect(injection.text).toBe('');
        expect(injection.parts).toEqual([]);
    });
});

describe('measureInjection', () => {
    it('counts the text it was handed, not the current layers', async () => {
        const injection = buildInjection([[{ text: 'recall the ferry' }]], {
            injectionTemplate: 'wrap {{summary}} here',
        });

        const usage = await measureInjection(injection);
        const expected = await countTextTokens(injection.text);

        expect(usage.total.count).toBe(expected.count);
    });

    it('reports layer parts aligned to the measured total', async () => {
        const layers = [[{ text: 'First beat.' }], [{ text: 'Second beat.' }]];
        const injection = buildInjection(layers, { injectionTemplate: 'A {{summary}} B' });

        const usage = await measureInjection(injection);
        const partTotal = usage.parts.reduce((sum, part) => sum + part.count, 0);

        expect(usage.layers.map((part) => part.layerIndex)).toEqual([1, 0]);
        expect(partTotal).toBe(usage.total.count);
    });

    it('returns an empty usage for an empty injection', async () => {
        const usage = await measureInjection({ text: '', parts: [] });

        expect(usage.total).toEqual({ count: 0, estimated: false });
        expect(usage.parts).toEqual([]);
    });

    it('carries no text of its own — the caller holds what it measured', async () => {
        const injection = buildInjection([[{ text: 'some memory' }]], {});

        const usage = await measureInjection(injection);

        expect(usage).not.toHaveProperty('text');
    });
});

describe('microfiche effective cap in production injection', () => {
    it('reads the slider, host, and preset budgets with overflow as text', () => {
        const knobs = {
            injectionTemplate: '{{summary}}',
            memoryMode: 'microfiche',
            microficheFont: '8x8',
            microficheCellWidth: 8,
            microficheCellHeight: 22,
            microficheStretch: false,
            microficheVariant: 'bw',
            microficheStopwordDim: false,
            microficheColumns: 1,
            microficheLineRepeat: 1,
            microficheFrameSize: 64,
            microficheKeepRaw: 0,
            microficheGeometry: 'google',
            microficheImageCap: 8,
        };
        const layers = [
            [{ text: 'aaa bbb ccc' }, { text: 'ddd eee fff' }],
            [{ text: 'ggg hhh iii' }, { text: 'jjj kkk lll' }],
        ];
        const injection = buildInjection(layers, knobs);
        expect(injection.microfiche.effectiveCap).toBe(8);
        expect(injection.microfiche.imageTexts.length).toBeLessThanOrEqual(8);
        expect(injection.microfiche.shape).toMatchObject({ font: '8x8', frameSize: 64 });
        const hosted = buildInjection(layers, knobs, { imageBudget: 1 });
        expect(hosted.microfiche.effectiveCap).toBe(1);
        expect(hosted.microfiche.imageTexts.length).toBeLessThanOrEqual(1);
        expect(hosted.microfiche.rawTexts.length).toBeGreaterThan(0);
        const flat = layers
            .flat()
            .map((snippet) => formatAnchoredSnippetNarrative(snippet, formatSnippetAnchor));
        expect(hosted.microfiche.imageTexts.length).toBe(
            buildMicrofichePlan(flat, knobs, { imageBudget: 1 }).imageTexts.length,
        );
        expect(injection.text).toContain('aaa bbb ccc');
        const custom = buildInjection(layers, { ...knobs, microficheGeometry: 'custom' });
        expect(custom.microfiche).not.toBeNull();
        expect(custom.microfiche.imageTexts.length).toBeGreaterThan(0);
        expect(custom.microfiche.effectiveCap).toBe(8);
    });
});

describe('buildMemoryBody', () => {
    it('returns the bare memory text with no template wrapping', () => {
        const body = buildMemoryBody([[{ text: 'The party reached the tavern.' }]]);

        expect(body).toBe('The party reached the tavern.');
    });

    it('anchors with the one compact form, the same as the injection', () => {
        installSummaryContext({ chat: makeMessages(8) });
        const layers = [
            [
                {
                    sourceMessageIds: ['message-2', 'message-5'],
                    currentDateTime: '2024-01-02 14',
                    text: 'She left.',
                },
            ],
        ];

        expect(buildMemoryBody(layers)).toBe('[2-5@2024-01-02T14] She left.');
        expect(buildInjection(layers, { injectionTemplate: '{{summary}}' }).text).toBe(
            '[2-5@2024-01-02T14] She left.',
        );
    });

    it('is the memory body of the same parts builder', () => {
        const layers = [[{ text: 'First beat.' }], [{ text: 'Second beat.' }]];

        expect(buildMemoryBody(layers)).toBe(buildMemoryInjectionParts(layers).memoryText);
    });
});

describe('renderInjectionTemplate', () => {
    it('inserts memory text containing $-sequences literally', () => {
        const result = renderInjectionTemplate(
            { memoryText: 'price is $& and $1 special' },
            { injectionTemplate: 'A {{summary}} B {{summary}} C' },
        );

        expect(result).not.toContain('{{summary}}');
        expect(result).toContain('price is $& and $1 special');
        const occurrences = result.split('price is $& and $1 special').length - 1;
        expect(occurrences).toBe(2);
    });
});

describe('memory injection placement', () => {
    // 10000 is the host's maximum injection depth, so the slot clamps to the
    // first chat-history message: after every preset block, before chat text.
    it('places the default slot at the start of chat history', () => {
        const writer = makeMemoryInjectionWriter();

        expect(writer.options(defaultSettings)).toEqual({
            position: EXTENSION_PROMPT_POSITIONS.IN_CHAT,
            depth: 10000,
            scan: false,
            role: EXTENSION_PROMPT_ROLES.SYSTEM,
        });
    });

    it('writes the default slot with that placement', () => {
        const setExtensionPrompt = vi.fn();
        installSummaryContext({
            chat: makeMessages(4),
            settings: { ...defaultSettings },
            setExtensionPrompt,
        });
        const writer = makeMemoryInjectionWriter();

        writer.update();

        const [, , position, depth, scan, role] = setExtensionPrompt.mock.calls[0];
        expect({ position, depth, scan, role }).toEqual({
            position: EXTENSION_PROMPT_POSITIONS.IN_CHAT,
            depth: 10000,
            scan: false,
            role: EXTENSION_PROMPT_ROLES.SYSTEM,
        });
    });

    it('keeps every explicit placement choice', () => {
        const writer = makeMemoryInjectionWriter();
        const options = (customMemoryPosition, customMemoryDepth = 0) =>
            writer.options({ ...defaultSettings, customMemoryPosition, customMemoryDepth });

        expect(options(MEMORY_POSITIONS.BEFORE_PROMPT)).toMatchObject({
            position: EXTENSION_PROMPT_POSITIONS.BEFORE_PROMPT,
            depth: 0,
        });
        expect(options(MEMORY_POSITIONS.IN_PROMPT)).toMatchObject({
            position: EXTENSION_PROMPT_POSITIONS.IN_PROMPT,
            depth: 0,
        });
        expect(options(MEMORY_POSITIONS.IN_CHAT, 3)).toMatchObject({
            position: EXTENSION_PROMPT_POSITIONS.IN_CHAT,
            depth: 3,
        });
        expect(options(MEMORY_POSITIONS.MACRO_ONLY)).toMatchObject({
            position: EXTENSION_PROMPT_POSITIONS.NONE,
            depth: 0,
        });
    });
});
