import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SETTINGS_HELP, calculateHelpTooltipPosition } from '../src/entry/settings-help.js';

const SETTINGS_HTML = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');

const SLIDER_HELP_KEYS = [
    'verbatim_token_budget',
    'memory_token_budget',
    'layer0_summary_token_target',
    'max_l0_source_tokens',
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

    it('places connection routes in Models and context preview directly before tuning', () => {
        const modelsTab = SETTINGS_HTML.indexOf('data-sc-tab="models"');
        const modelsPanel = SETTINGS_HTML.indexOf('data-sc-panel="models"');
        const settingsPanel = SETTINGS_HTML.indexOf('data-sc-panel="settings"');
        const promptsPanel = SETTINGS_HTML.indexOf('data-sc-panel="prompts"');
        const connectionPanel = SETTINGS_HTML.indexOf('id="summaryception_connection_settings"');
        const inputProcessing = SETTINGS_HTML.indexOf('Input Processing', settingsPanel);
        const llmContext = SETTINGS_HTML.indexOf('LLM Call Context', settingsPanel);
        const engineTuning = SETTINGS_HTML.indexOf('Engine Tuning', settingsPanel);
        const memoryPosition = SETTINGS_HTML.indexOf('Memory Position', settingsPanel);

        expect(modelsTab).toBeGreaterThan(-1);
        expect(connectionPanel).toBeGreaterThan(modelsPanel);
        expect(connectionPanel).toBeLessThan(settingsPanel);
        expect(inputProcessing).toBeGreaterThan(settingsPanel);
        expect(llmContext).toBeGreaterThan(inputProcessing);
        expect(llmContext).toBeLessThan(engineTuning);
        expect(memoryPosition).toBeGreaterThan(engineTuning);
        expect(memoryPosition).toBeLessThan(promptsPanel);
    });

    it('uses the fixed source and batch slider ranges and defaults', () => {
        expect(SETTINGS_HTML).toContain(
            'id="sc_max_l0_source_tokens" min="8000" max="64000" step="1000"',
        );
        expect(SETTINGS_HTML).toContain(
            'id="sc_max_l0_source_tokens_val" class="text_pole sc-val sc-val-wide" type="text" inputmode="numeric" value="24k"',
        );
        expect(SETTINGS_HTML).toContain(
            'id="sc_min_summary_budget" min="4000" max="32000" step="1000"',
        );
        expect(SETTINGS_HTML).toContain(
            'id="sc_min_summary_budget_val" class="text_pole sc-val sc-val-wide" type="text" inputmode="numeric" value="16k"',
        );
        expect(SETTINGS_HTML).not.toContain('data-sc-slider-max-setting');
    });

    it('documents every role-mask mode and its request-only compatibility risk', () => {
        const roleMaskHelp = SETTINGS_HELP.mask_user_role_as_assistant;

        expect(roleMaskHelp.controls).toEqual([
            '#sc_mask_user_role_as_assistant',
            '#sc_mask_user_role_mode',
        ]);
        expect(roleMaskHelp.detail).toContain('Synthetic user marker');
        expect(roleMaskHelp.detail).toContain('marker first');
        expect(roleMaskHelp.detail).toContain('marker last');
        expect(roleMaskHelp.detail).toContain('keep the final user block');
        expect(roleMaskHelp.detail).toContain('request-only');
        expect(roleMaskHelp.detail).toContain('providers may normalize or reject');
        expect(SETTINGS_HTML).toContain('<option value="rewrite_all">No synthetic user marker</option>');
    });

    it('generates the expected Layer 0, Merge, and Fallback connection labels', () => {
        for (const [prefix, group] of Object.entries(CONNECTION_LABELS)) {
            for (const [key, suffix] of group.keys) {
                expect(SETTINGS_HELP[`${prefix}_${key}`].title).toBe(`${group.label} ${suffix}`);
            }
        }
    });

    it('keeps prompt presets limited to default and custom choices', () => {
        expect(SETTINGS_HTML).toContain('<option value="narrative">Default</option>');
        expect(SETTINGS_HTML).toContain('<option value="custom">Custom</option>');
    });

    it('documents provider defaults consistently for Layer 0, merge, and fallback output caps', () => {
        expect(SETTINGS_HELP.layer0_response_length.detail).toContain(
            '0 uses the selected provider default',
        );
        expect(SETTINGS_HELP.layer0_openai_max_tokens.detail).toContain(
            '0 leaves the provider default',
        );
        expect(SETTINGS_HELP.merge_openai_max_tokens.detail).toContain(
            '0 leaves the provider default',
        );
        expect(SETTINGS_HELP.fallback_openai_max_tokens.detail).toContain(
            '0 leaves the provider default',
        );
        expect(SETTINGS_HTML).toContain('placeholder="0 = provider default"');
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
