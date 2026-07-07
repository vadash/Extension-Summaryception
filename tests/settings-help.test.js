import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SETTINGS_HELP, calculateHelpTooltipPosition } from '../src/entry/settings-help.js';

const SETTINGS_HTML = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');

const SLIDER_HELP_KEYS = [
    'verbatim_token_budget',
    'memory_token_budget',
    'layer0_summary_token_target',
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

    it('documents memory budget and layering defaults in the settings UI', () => {
        expect(SETTINGS_HELP.memory_token_budget.short).toContain('Maximum');
        expect(SETTINGS_HELP.memory_token_budget.detail).toContain('ceiling');
        expect(SETTINGS_HELP.memory_token_budget.detail).toContain('4k');
        expect(SETTINGS_HELP.snippets_per_promotion.detail).toContain('Default 3');
        expect(SETTINGS_HELP.snippets_per_promotion.detail).toContain('2000+ message chats');
        expect(SETTINGS_HELP.snippets_per_layer.detail).toContain('Default 24');
        expect(SETTINGS_HTML).toContain('id="sc_snippets_per_layer" min="20" max="40" step="1"');
        expect(SETTINGS_HTML).toContain(
            'id="sc_snippets_per_layer_val" class="text_pole sc-val" type="text" inputmode="numeric" value="24"',
        );
        expect(SETTINGS_HTML).toContain(
            'id="sc_snippets_per_promotion_val" class="text_pole sc-val" type="text" inputmode="numeric" value="3"',
        );
    });

    it('generates the expected Layer 0, Merge, and Fallback connection labels', () => {
        for (const [prefix, group] of Object.entries(CONNECTION_LABELS)) {
            for (const [key, suffix] of group.keys) {
                expect(SETTINGS_HELP[`${prefix}_${key}`].title).toBe(`${group.label} ${suffix}`);
            }
        }
    });

    it('keeps Prompt Preset limited to narrative and custom choices', () => {
        expect(SETTINGS_HTML).toContain('<option value="narrative">Narrative State (Default)');
        expect(SETTINGS_HTML).toContain('<option value="custom">Custom</option>');
        expect(SETTINGS_HTML).not.toContain('value="gamestate"');
        expect(SETTINGS_HTML).not.toContain('Game State');
        expect(SETTINGS_HELP.prompt_preset.detail).not.toContain('game-state');
    });

    it('documents Layer 0 output caps separately from merge and fallback provider defaults', () => {
        expect(SETTINGS_HELP.layer0_response_length.detail).toContain(
            '0 uses the Layer 0 target plus a safety buffer',
        );
        expect(SETTINGS_HELP.layer0_openai_max_tokens.detail).toContain(
            '0 uses the Layer 0 target plus a safety buffer',
        );
        expect(SETTINGS_HELP.merge_openai_max_tokens.detail).toContain(
            '0 leaves the provider default',
        );
        expect(SETTINGS_HELP.fallback_openai_max_tokens.detail).toContain(
            '0 leaves the provider default',
        );
        expect(SETTINGS_HTML).toContain('placeholder="0 = target + buffer"');
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
