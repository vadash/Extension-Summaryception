import { describe, expect, it } from 'vitest';

import {
    buildInjection,
    buildMemoryBody,
    buildMemoryInjectionParts,
    measureInjection,
    renderInjectionTemplate,
} from '../src/core/memory-injection.js';
import { countTextTokens } from '../src/core/token-count.js';

describe('buildMemoryInjectionParts', () => {
    it('joins per-layer chronology sections under [CHRONOLOGY]', () => {
        const layers = [
            [{ text: 'The party reached the tavern.' }],
            [{ text: 'The ferry crossed at dawn.' }],
        ];

        const parts = buildMemoryInjectionParts(layers);

        expect(parts.memoryText).toContain('[CHRONOLOGY]');
        expect(parts.memoryText).toContain('The party reached the tavern.');
        expect(parts.memoryText).toContain('The ferry crossed at dawn.');
        expect(parts.memoryText).toBe(`[CHRONOLOGY]\n${parts.chronologyText}`);
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

        const memoryText = '[CHRONOLOGY]\nsome memory';
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

describe('buildMemoryBody', () => {
    it('returns the bare memory text with no template wrapping', () => {
        const body = buildMemoryBody([[{ text: 'The party reached the tavern.' }]]);

        expect(body).toContain('[CHRONOLOGY]');
        expect(body).toContain('The party reached the tavern.');
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
