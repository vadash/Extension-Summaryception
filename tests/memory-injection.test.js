import { describe, expect, it, vi } from 'vitest';

import {
    EXTENSION_PROMPT_POSITIONS,
    MEMORY_MODES,
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
import { formatMicroficheMarker } from '../src/core/microfiche-transport.js';
import {
    formatAnchoredSnippetNarrative,
    formatSnippetAnchor,
} from '../src/core/snippet-metadata.js';
import { countTextTokens } from '../src/core/token-count.js';
import {
    defaultSlotOptions,
    injectedSlotOptions,
    installSummaryContext,
    makeMemoryInjectionWriter,
    makeMessages,
    makeSummaryStore,
} from './test-helpers.js';

describe('Preserved Message injection rendering', () => {
    it('renders the worked example in global source order with one exact block', () => {
        const chat = makeMessages(7);
        installSummaryContext({ chat });
        const layers = [
            [{ sourceMessageIds: ['message-3', 'message-6'], text: 'Late summary.' }],
            [
                {
                    sourceMessageIds: ['message-0', 'message-1'],
                    text: 'Early summary.',
                    promoted: true,
                },
            ],
        ];
        const preservedMessages = [
            {
                id: 'message-2',
                text: 'Assistant: approved body',
                currentDateTime: '2024-01-02 14 Tue',
                handedOff: true,
            },
        ];

        const injection = buildInjection(layers, { injectionTemplate: '{{summary}}' }, null, {
            chat,
            preservedMessages,
        });

        expect(injection.text).toBe(
            '[0-1] Early summary.\n' +
                '[2-2@2024-01-02T14] <preserved>Assistant: approved body</preserved>\n' +
                '[3-6] Late summary.',
        );
    });

    it('places preserved text after a covering promoted snippet', () => {
        const chat = makeMessages(8);
        installSummaryContext({ chat });
        const layers = [
            [{ sourceMessageIds: ['message-7'], text: 'Later summary.' }],
            [
                {
                    sourceMessageIds: ['message-0', 'message-6'],
                    text: 'Covering summary.',
                    promoted: true,
                },
            ],
        ];

        const injection = buildInjection(layers, { injectionTemplate: '{{summary}}' }, null, {
            chat,
            preservedMessages: [{ id: 'message-2', text: 'Assistant: exact', handedOff: true }],
        });

        expect(injection.text).toBe(
            '[0-6] Covering summary.\n' +
                '[2-2] <preserved>Assistant: exact</preserved>\n' +
                '[7-7] Later summary.',
        );
    });

    it('renders only handed-off records whose stable identity still resolves', () => {
        const chat = makeMessages(3);
        installSummaryContext({ chat });
        const injection = buildInjection([], { injectionTemplate: '{{summary}}' }, null, {
            chat,
            preservedMessages: [
                { id: 'message-0', text: 'Assistant: pending', handedOff: false },
                { id: 'deleted', text: 'Assistant: deleted', handedOff: true },
                { id: 'message-1', text: 'Assistant: kept', handedOff: true },
            ],
        });

        expect(injection.text).toBe('[1-1] <preserved>Assistant: kept</preserved>');
    });

    it('puts preserved text in the first placeholder and snippets in later placeholders', () => {
        const chat = makeMessages(3);
        installSummaryContext({ chat });
        const injection = buildInjection(
            [[{ sourceMessageIds: ['message-0'], text: 'Snippet memory.' }]],
            { injectionTemplate: 'A {{summary}} B {{summary}} C' },
            null,
            {
                chat,
                preservedMessages: [{ id: 'message-1', text: 'Assistant: exact', handedOff: true }],
            },
        );

        expect(injection.text.split('<preserved>').length - 1).toBe(1);
        expect(injection.text.split('Snippet memory.').length - 1).toBe(2);
        expect(injection.text).toContain('B [0-0] Snippet memory. C');
    });

    it('renders the template for a preserved-only body', () => {
        const chat = makeMessages(2);
        installSummaryContext({ chat });
        const injection = buildInjection([], { injectionTemplate: 'Memory: {{summary}}' }, null, {
            chat,
            preservedMessages: [{ id: 'message-0', text: 'User: exact', handedOff: true }],
        });

        expect(injection.text).toBe('Memory: [0-0] <preserved>User: exact</preserved>');
    });

    it('keeps Memory Body and snippet-only injection free of preserved text', () => {
        const chat = makeMessages(3);
        installSummaryContext({ chat });
        const layers = [[{ sourceMessageIds: ['message-0'], text: 'Snippet memory.' }]];
        const preservedMessages = [{ id: 'message-1', text: 'Assistant: exact', handedOff: true }];

        expect(buildMemoryBody(layers)).not.toContain('Assistant: exact');
        expect(buildInjection(layers, { injectionTemplate: '{{summary}}' }).text).not.toContain(
            'Assistant: exact',
        );
        expect(preservedMessages[0].handedOff).toBe(true);
    });

    it('explains the preserved tag in the default legend', () => {
        expect(defaultSettings.injectionTemplate).toContain('<preserved>');
    });

    it('resolves snippet anchors from the passed chat rather than host positions', () => {
        installSummaryContext({ chat: makeMessages(4) });
        const chat = [
            { sc_id: 'source-a', is_user: false, is_system: false, mes: 'a' },
            { sc_id: 'source-b', is_user: false, is_system: false, mes: 'b' },
        ];
        const layers = [[{ sourceMessageIds: ['source-a', 'source-b'], text: 'Snippet.' }]];

        const injection = buildInjection(layers, { injectionTemplate: '{{summary}}' }, null, {
            chat,
        });

        expect(injection.text).toBe('[0-1] Snippet.');
    });
});

describe('Preserved Message Microfiche integration', () => {
    const settings = {
        ...defaultSettings,
        injectionTemplate: '{{summary}}',
        memoryMode: MEMORY_MODES.MICROFICHE,
        microficheGeometry: 'custom',
        microficheFont: '8x8',
        microficheCellWidth: 8,
        microficheCellHeight: 22,
        microficheStretch: false,
        microficheVariant: 'bw',
        microficheStopwordDim: false,
        microficheColumns: 1,
        microficheLineRepeat: 1,
        microficheFrameSize: 64,
        microficheImageCap: 8,
        microficheKeepRaw: 0,
    };

    function fixture() {
        const chat = makeMessages(3);
        const layers = [
            [
                { sourceMessageIds: ['message-0'], text: 'a' },
                { sourceMessageIds: ['message-2'], text: 'b' },
            ],
        ];
        const preservedMessages = [
            { id: 'message-1', text: 'Assistant: exact body', handedOff: true },
        ];
        return { chat, layers, preservedMessages };
    }

    it('keeps preserved text literal and positioned outside image pages', () => {
        const { chat, layers, preservedMessages } = fixture();
        installSummaryContext({ chat });

        const injection = buildInjection(layers, settings, null, {
            chat,
            preservedMessages,
        });

        expect(injection.microfiche.imageTexts.join('\n')).not.toContain('exact body');
        expect(injection.microfiche.segments).toEqual([
            { kind: 'image' },
            {
                kind: 'text',
                text: '[1-1] <preserved>Assistant: exact body</preserved>',
                preserved: true,
            },
            { kind: 'image' },
        ]);
    });

    it('writes preserved text once between memory markers in the final slot', () => {
        const { chat, layers, preservedMessages } = fixture();
        const setExtensionPrompt = vi.fn();
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore({ layers, preservedMessages }) },
            settings: { ...settings, injectionTemplate: 'A {{summary}} B {{summary}} C' },
            setExtensionPrompt,
        });
        const writer = makeMemoryInjectionWriter();

        writer.update();

        const text = setExtensionPrompt.mock.calls[0][1];
        const firstCopyEnd = text.indexOf(' B ');
        const firstMarker = text.indexOf(formatMicroficheMarker(0));
        const preservedAt = text.indexOf('<preserved>Assistant: exact body</preserved>');
        const secondMarker = text.indexOf(formatMicroficheMarker(1));
        expect(text.split('<preserved>').length - 1).toBe(1);
        expect(firstMarker).toBeGreaterThanOrEqual(0);
        expect(preservedAt).toBeGreaterThan(firstMarker);
        expect(secondMarker).toBeGreaterThan(preservedAt);
        expect(firstCopyEnd).toBeGreaterThan(secondMarker);
    });

    it('keeps preserved text literal when the image budget is zero', () => {
        const { chat, layers, preservedMessages } = fixture();
        const setExtensionPrompt = vi.fn();
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore({ layers, preservedMessages }) },
            settings: {
                ...settings,
                microficheGeometry: 'google',
                microficheImageCap: 1,
                verbatimTokenBudget: 1,
                queuedTokenBudget: 1,
            },
            setExtensionPrompt,
        });
        const writer = makeMemoryInjectionWriter({ host: { imageBudget: 0 } });

        writer.update();

        const text = setExtensionPrompt.mock.calls[0][1];
        expect(text).toContain('<preserved>Assistant: exact body</preserved>');
        expect(text).not.toContain(formatMicroficheMarker(0));
    });

    it('builds UI preview and accounting from the same preserved renderer', async () => {
        const { chat, layers, preservedMessages } = fixture();
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore({ layers, preservedMessages }) },
            settings,
        });
        const { buildUiInjection } = await import('../src/entry/ui.js');
        const { getChatStore } = await import('../src/foundation/chat-store.js');

        const injection = buildUiInjection(getChatStore(), settings);
        const usage = await measureInjection(injection);

        expect(injection.text).toContain('[1-1] <preserved>Assistant: exact body</preserved>');
        expect(usage.preserved?.kind).toBe('preserved');
    });
});

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
            snippetText: '',
            preservedText: '',
            entries: [],
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
    it('counts preserved text as a separate token category outside layers', async () => {
        const chat = makeMessages(3);
        installSummaryContext({ chat });
        const layers = [[{ sourceMessageIds: ['message-0'], text: 'Snippet memory.' }]];
        const options = {
            chat,
            preservedMessages: [
                { id: 'message-1', text: 'Assistant: exact preserved body', handedOff: true },
            ],
        };
        const injection = buildInjection(
            layers,
            { injectionTemplate: 'wrap {{summary}}' },
            null,
            options,
        );
        const snippetOnly = buildInjection(layers, { injectionTemplate: 'wrap {{summary}}' });

        const usage = await measureInjection(injection);
        const snippetUsage = await measureInjection(snippetOnly);
        const expectedPreserved = await countTextTokens(injection.preservedParts[0].text);

        expect(usage.preserved).toMatchObject({
            label: 'Preserved',
            kind: 'preserved',
            count: expectedPreserved.count,
            estimated: expectedPreserved.estimated,
        });
        expect(usage.layers).toEqual(snippetUsage.layers);
        expect(usage.parts.some((part) => part.kind === 'preserved')).toBe(true);
        expect(usage.parts.reduce((sum, part) => sum + part.count, 0)).toBe(usage.total.count);
        expect(usage.total.count).toBe((await countTextTokens(injection.text)).count);
        expect(snippetUsage.preserved).toBeNull();
    });

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
    // The default depth is the host maximum, so the slot clamps to the first
    // chat-history message: after every preset block, before chat text.
    it('places the default slot at the start of chat history', () => {
        const writer = makeMemoryInjectionWriter();

        expect(writer.options(defaultSettings)).toEqual(defaultSlotOptions());
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

        expect(injectedSlotOptions(setExtensionPrompt)).toEqual(defaultSlotOptions());
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

describe('memory injection slot facts', () => {
    it('exposes the committed text, placement, presence, and injection key', () => {
        const chat = makeMessages(4);
        const layers = [[{ sourceMessageIds: ['message-0'], text: 'Snippet memory.' }]];
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore({ layers }) },
            settings: { ...defaultSettings, enabled: true },
            setExtensionPrompt: vi.fn(),
        });
        const writer = makeMemoryInjectionWriter();

        writer.update();
        const facts = writer.getSlotFacts();

        expect(typeof facts.text).toBe('string');
        expect(facts.text).not.toBe('');
        expect(facts.hasSlot).toBe(true);
        expect(facts.options).toEqual(defaultSlotOptions());
        expect(JSON.parse(facts.lastInjectionKey)).toEqual({
            text: facts.text,
            options: facts.options,
        });
    });

    it('keeps the injection key as the freshness fact for the last write', () => {
        const chat = makeMessages(4);
        const layers = [[{ sourceMessageIds: ['message-1'], text: 'Second memory.' }]];
        const setExtensionPrompt = vi.fn();
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore({ layers }) },
            settings: { ...defaultSettings, enabled: true },
            setExtensionPrompt,
        });
        const writer = makeMemoryInjectionWriter();

        writer.update();
        const first = writer.getSlotFacts();
        writer.update();
        const second = writer.getSlotFacts();

        expect(second.lastInjectionKey).toBe(first.lastInjectionKey);
        expect(second.text).toBe(first.text);
        expect(setExtensionPrompt).toHaveBeenCalled();
    });

    it('reports absent presence for empty, Macro-only, and disabled placements', () => {
        installSummaryContext({
            chat: makeMessages(2),
            metadata: { summaryception: makeSummaryStore({ layers: [] }) },
            settings: { ...defaultSettings, enabled: true },
            setExtensionPrompt: vi.fn(),
        });
        const emptyWriter = makeMemoryInjectionWriter();
        emptyWriter.update();
        expect(emptyWriter.getSlotFacts().hasSlot).toBe(false);
        expect(emptyWriter.getSlotFacts().text).toBe('');

        installSummaryContext({
            chat: makeMessages(2),
            metadata: {
                summaryception: makeSummaryStore({
                    layers: [[{ sourceMessageIds: ['message-0'], text: 'Snippet memory.' }]],
                }),
            },
            settings: {
                ...defaultSettings,
                enabled: true,
                customMemoryPosition: MEMORY_POSITIONS.MACRO_ONLY,
            },
            setExtensionPrompt: vi.fn(),
        });
        const macroWriter = makeMemoryInjectionWriter();
        macroWriter.update();
        const macroFacts = macroWriter.getSlotFacts();
        expect(macroFacts.hasSlot).toBe(false);
        expect(macroFacts.options.position).toBe(EXTENSION_PROMPT_POSITIONS.NONE);

        installSummaryContext({
            chat: makeMessages(2),
            settings: { ...defaultSettings, enabled: false },
            setExtensionPrompt: vi.fn(),
        });
        const offWriter = makeMemoryInjectionWriter();
        offWriter.update();
        expect(offWriter.getSlotFacts().hasSlot).toBe(false);
    });

    it('returns a frozen copy that cannot mutate committed state', () => {
        const chat = makeMessages(4);
        const layers = [[{ sourceMessageIds: ['message-0'], text: 'Snippet memory.' }]];
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore({ layers }) },
            settings: { ...defaultSettings, enabled: true },
            setExtensionPrompt: vi.fn(),
        });
        const writer = makeMemoryInjectionWriter();
        writer.update();

        const facts = writer.getSlotFacts();
        expect(Object.isFrozen(facts)).toBe(true);
        expect(Object.isFrozen(facts.options)).toBe(true);
        const before = writer.getSlotFacts().text;
        try {
            /** @type {{ text?: unknown }} */ (facts).text = 'mutated';
        } catch {
            // Frozen facts reject mutation.
        }
        expect(writer.getSlotFacts().text).toBe(before);
    });
});
