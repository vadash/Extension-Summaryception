import { describe, expect, it } from 'vitest';

import { buildEffectiveMemoryText } from '../src/core/memory-budget.js';
import {
    buildMemoryInjectionParts,
    renderInjectionTemplate,
} from '../src/core/memory-injection.js';

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

describe('buildEffectiveMemoryText', () => {
    it('replaces every {{summary}} occurrence in the injection template', () => {
        const layers = [[{ text: 'some memory' }]];
        const result = buildEffectiveMemoryText(layers, {
            injectionTemplate: 'A {{summary}} B {{summary}} C',
        });

        expect(result).not.toContain('{{summary}}');
        expect(result).toContain('A ');
        expect(result).toContain(' B ');
        expect(result).toContain(' C');
        const memoryText = '[CHRONOLOGY]\nsome memory';
        const occurrences = result.split(memoryText).length - 1;
        expect(occurrences).toBe(2);
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
