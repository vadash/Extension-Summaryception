import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SETTINGS_HELP, calculateHelpTooltipPosition } from '../src/entry/settings-help.js';

const SETTINGS_HTML = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');

const SLIDER_HELP_KEYS = [
    'verbatim_token_budget',
    'memory_token_budget',
    'min_summary_budget',
    'min_summary_turns',
    'max_summary_turns',
    'snippets_per_layer',
    'snippets_per_promotion',
];

const CONNECTION_LABELS = {
    layer0: {
        label: 'Layer 0',
        keys: [
            ['source', 'Source'],
            ['response_length', 'Response Length'],
            ['profile', 'Profile'],
            ['ollama_model', 'Ollama Model'],
            ['openai_model', 'OpenAI Model'],
            ['openai_max_tokens', 'Max Tokens'],
        ],
    },
    merge: {
        label: 'Merge',
        keys: [
            ['source', 'Source'],
            ['response_length', 'Response Length'],
            ['profile', 'Profile'],
            ['ollama_model', 'Ollama Model'],
            ['openai_model', 'OpenAI Model'],
            ['openai_max_tokens', 'Max Tokens'],
        ],
    },
    fallback: {
        label: 'Fallback',
        keys: [
            ['source', 'Source'],
            ['response_length', 'Response Length'],
            ['profile', 'Profile'],
            ['ollama_model', 'Ollama Model'],
            ['openai_model', 'OpenAI Model'],
            ['openai_max_tokens', 'Max Tokens'],
        ],
    },
};

describe('settings help metadata', () => {
    it('defines complete entries with selectors that exist in settings.html', () => {
        const keys = Object.keys(SETTINGS_HELP);
        expect(keys.length).toBeGreaterThan(0);
        expect(new Set(keys).size).toBe(keys.length);

        for (const [key, entry] of Object.entries(SETTINGS_HELP)) {
            expect(entry.selector, key).toBeTruthy();
            expect(entry.title, key).toBeTruthy();
            expect(entry.short, key).toBeTruthy();
            expect(entry.detail, key).toBeTruthy();
            expect(selectorExists(entry.selector), `${key}: ${entry.selector}`).toBe(true);

            for (const controlSelector of entry.controls || []) {
                expect(selectorExists(controlSelector), `${key}: ${controlSelector}`).toBe(true);
            }
        }
    });

    it('keeps slider help explicit about higher, lower, and default behavior', () => {
        for (const key of SLIDER_HELP_KEYS) {
            const detail = SETTINGS_HELP[key].detail;
            expect(detail, key).toMatch(/\bHigher\b/);
            expect(detail, key).toMatch(/\bLower\b/);
            expect(detail, key).toMatch(/\bDefault\b/);
        }
    });

    it('generates the expected Layer 0, Merge, and Fallback connection labels', () => {
        for (const [prefix, group] of Object.entries(CONNECTION_LABELS)) {
            for (const [key, suffix] of group.keys) {
                expect(SETTINGS_HELP[`${prefix}_${key}`].title).toBe(`${group.label} ${suffix}`);
            }
        }
    });

    it('keeps tooltip placement inside the viewport and settings width', () => {
        const position = calculateHelpTooltipPosition({
            anchorRect: { left: 760, right: 780, top: 550, bottom: 570 },
            settingsRect: { left: 20, right: 820 },
            tooltipWidth: 320,
            tooltipHeight: 120,
            viewportWidth: 840,
            viewportHeight: 600,
        });

        expect(position.left).toBeLessThanOrEqual(494);
        expect(position.top).toBe(424);
    });
});

function selectorExists(selector) {
    const idSelector = /^#([\w-]+)$/.exec(selector);
    if (idSelector) {
        return SETTINGS_HTML.includes(`id="${idSelector[1]}"`);
    }

    const labelSelector = /^label\[for="([\w-]+)"\]$/.exec(selector);
    if (labelSelector) {
        return SETTINGS_HTML.includes(`for="${labelSelector[1]}"`);
    }

    throw new Error(`Unsupported test selector: ${selector}`);
}
