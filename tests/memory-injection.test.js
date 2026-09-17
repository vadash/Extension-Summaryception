import { describe, expect, it } from 'vitest';

import { buildEffectiveMemoryText } from '../src/core/memory-budget.js';
import {
    buildMemoryInjectionParts,
    renderInjectionTemplate,
} from '../src/core/memory-injection.js';

function snippetWithState(narrative, stateLines) {
    const state = stateLines.map((line) => line).join('\n');
    return {
        text: `[NARRATIVE]\n${narrative}\n[STATE]\n${state}`,
    };
}

describe('buildMemoryInjectionParts with injectCurrentState', () => {
    it('prepends the [CURRENT STATE] block by default', () => {
        const layers = [
            [
                snippetWithState('The party reached the tavern.', [
                    'location: tavern',
                    'mood: tense',
                ]),
            ],
        ];

        const parts = buildMemoryInjectionParts(layers);

        expect(parts.stateText).toContain('[CURRENT STATE]');
        expect(parts.memoryText).toContain('[CURRENT STATE]');
        expect(parts.memoryText).toContain('[CHRONOLOGY]');
    });

    it('drops the state block and keeps only chronology when injectCurrentState is false', () => {
        const layers = [
            [
                snippetWithState('The party reached the tavern.', [
                    'location: tavern',
                    'mood: tense',
                ]),
            ],
        ];

        const parts = buildMemoryInjectionParts(layers, { injectCurrentState: false });

        expect(parts.stateText).toBe('');
        expect(parts.memoryText).not.toContain('[CURRENT STATE]');
        expect(parts.memoryText).not.toContain('[STATE]');
        expect(parts.memoryText).toContain('[CHRONOLOGY]');
    });

    it('still reports the chronology parts when the state is suppressed', () => {
        const layers = [[snippetWithState('First beat.', ['location: tavern'])]];

        const parts = buildMemoryInjectionParts(layers, { injectCurrentState: false });

        expect(parts.chronologyParts).toHaveLength(1);
        expect(parts.chronologyParts[0].layerIndex).toBe(0);
        expect(parts.chronologyParts[0].text).toContain('First beat.');
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
